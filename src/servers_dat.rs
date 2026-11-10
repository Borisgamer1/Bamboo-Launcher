//! Lesen und Schreiben der Minecraft-Serverliste (`servers.dat`).
//!
//! Die Datei ist gzip-komprimiertes NBT. Der Launcher pflegt seine eigene
//! Liste; damit ein dort eingetragener Server auch im Spiel auftaucht, wird sie
//! zusätzlich in die Instanz geschrieben. Server, die nur im Spiel eingetragen
//! wurden, bleiben dabei erhalten.

use crate::error::Result;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::{Read, Write};
use std::path::Path;

pub const FILE_NAME: &str = "servers.dat";
/// Schutz gegen beschädigte Dateien mit absurd vielen Einträgen.
const MAX_SERVERS: i32 = 4096;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServerEntry {
    pub name: String,
    pub ip: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Einträge, die nach dem Zusammenführen in der Datei stehen.
    pub written: usize,
    /// Einträge, die es nur im Spiel gab und die deshalb geblieben sind.
    pub kept: usize,
}

/// Liest die Serverliste. Eine fehlende oder beschädigte Datei ergibt eine
/// leere Liste; der nächste Schreibvorgang ersetzt sie dann vollständig.
pub fn read(path: &Path) -> Vec<ServerEntry> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut decoder = GzDecoder::new(file);
    let mut data = Vec::new();
    if decoder.read_to_end(&mut data).is_err() {
        return Vec::new();
    }
    parse(&data).unwrap_or_default()
}

/// Ergänzt die Launcher-Server in der bestehenden Liste. Gleiche IP zählt als
/// derselbe Server; der Launcher-Name gewinnt.
pub fn merge(mut existing: Vec<ServerEntry>, launcher: &[ServerEntry]) -> Vec<ServerEntry> {
    existing.retain(|entry| !entry.ip.trim().is_empty());
    for entry in launcher {
        let ip = entry.ip.trim();
        if ip.is_empty() {
            continue;
        }
        let name = entry.name.trim();
        match existing
            .iter_mut()
            .find(|known| known.ip.eq_ignore_ascii_case(ip))
        {
            Some(known) => {
                if !name.is_empty() {
                    known.name = name.to_string();
                }
            }
            None => existing.push(ServerEntry {
                name: if name.is_empty() { ip } else { name }.to_string(),
                ip: ip.to_string(),
            }),
        }
    }
    existing
}

/// Schreibt die Liste und meldet, wie viele Einträge übernommen wurden.
pub fn sync(path: &Path, launcher: &[ServerEntry]) -> Result<SyncReport> {
    let existing = read(path);
    let kept = existing
        .iter()
        .filter(|entry| {
            !entry.ip.trim().is_empty()
                && !launcher
                    .iter()
                    .any(|wanted| wanted.ip.trim().eq_ignore_ascii_case(entry.ip.trim()))
        })
        .count();
    let merged = merge(existing, launcher);
    let written = write(path, &merged)?;
    Ok(SyncReport { written, kept })
}

/// Schreibt die Einträge als gzip-komprimiertes NBT.
pub fn write(path: &Path, entries: &[ServerEntry]) -> Result<usize> {
    let entries: Vec<&ServerEntry> = entries
        .iter()
        .filter(|entry| !entry.ip.trim().is_empty())
        .collect();
    let payload = encode(&entries);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&payload)?;
    let compressed = encoder.finish()?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Erst daneben schreiben, dann ersetzen: ein Abbruch darf keine halbe
    // Serverliste hinterlassen.
    let temp = path.with_extension("dat.tmp");
    std::fs::write(&temp, compressed)?;
    std::fs::rename(&temp, path)?;
    Ok(entries.len())
}

fn encode(entries: &[&ServerEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(10); // TAG_Compound, leerer Name
    write_string(&mut out, "");

    out.push(9); // TAG_List
    write_string(&mut out, "servers");
    out.push(10); // Elemente sind Compounds
    out.extend_from_slice(&(entries.len() as i32).to_be_bytes());

    for entry in entries {
        // Listenelemente tragen nur ihre Nutzlast; Typ und Länge stehen
        // einmal im Listenkopf.
        out.push(8);
        write_string(&mut out, "name");
        write_string(&mut out, entry.name.trim());
        out.push(8);
        write_string(&mut out, "ip");
        write_string(&mut out, entry.ip.trim());
        out.push(1); // TAG_Byte
        write_string(&mut out, "acceptTextures");
        out.push(1);
        out.push(0); // Compound Ende
    }

    out.push(0); // Root Ende
    out
}

fn write_string(out: &mut Vec<u8>, text: &str) {
    let bytes = mutf8(text);
    out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(&bytes);
}

/// NBT benutzt Javas „modified UTF-8“: Null wird als `C0 80` kodiert und
/// Zeichen außerhalb der BMP als zwei Surrogat-Tripel.
fn mutf8(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    for unit in text.encode_utf16() {
        match unit {
            0x0001..=0x007F => out.push(unit as u8),
            0x0000..=0x07FF => {
                out.push(0xC0 | (unit >> 6) as u8);
                out.push(0x80 | (unit & 0x3F) as u8);
            }
            _ => {
                out.push(0xE0 | (unit >> 12) as u8);
                out.push(0x80 | ((unit >> 6) & 0x3F) as u8);
                out.push(0x80 | (unit & 0x3F) as u8);
            }
        }
    }
    out
}

fn read_mutf8(bytes: &[u8]) -> String {
    let mut units = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let first = bytes[index];
        let (unit, width) = if first & 0x80 == 0 {
            (first as u16, 1)
        } else if first & 0xE0 == 0xC0 && index + 1 < bytes.len() {
            (
                (((first & 0x1F) as u16) << 6) | (bytes[index + 1] & 0x3F) as u16,
                2,
            )
        } else if first & 0xF0 == 0xE0 && index + 2 < bytes.len() {
            (
                (((first & 0x0F) as u16) << 12)
                    | (((bytes[index + 1] & 0x3F) as u16) << 6)
                    | (bytes[index + 2] & 0x3F) as u16,
                3,
            )
        } else {
            break;
        };
        units.push(unit);
        index += width;
    }
    String::from_utf16_lossy(&units)
}

// ---------------------------------------------------------------------------
// NBT-Parser
// ---------------------------------------------------------------------------

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(count)?;
        let slice = self.data.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }

    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|slice| slice[0])
    }

    fn u16(&mut self) -> Option<u16> {
        self.take(2)
            .map(|slice| u16::from_be_bytes([slice[0], slice[1]]))
    }

    fn i32(&mut self) -> Option<i32> {
        let slice = self.take(4)?;
        Some(i32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
    }

    fn string(&mut self) -> Option<String> {
        let length = self.u16()? as usize;
        Some(read_mutf8(self.take(length)?))
    }

    /// Überspringt eine Nutzlast, die nicht gebraucht wird.
    fn skip(&mut self, tag: u8) -> Option<()> {
        match tag {
            1 => self.take(1).map(|_| ()),
            2 => self.take(2).map(|_| ()),
            3 => self.take(4).map(|_| ()),
            4 => self.take(8).map(|_| ()),
            5 => self.take(4).map(|_| ()),
            6 => self.take(8).map(|_| ()),
            7 => {
                let length = self.i32()?.max(0) as usize;
                self.take(length).map(|_| ())
            }
            8 => self.string().map(|_| ()),
            9 => {
                let element = self.u8()?;
                let length = self.i32()?.max(0) as usize;
                if element == 0 {
                    return Some(());
                }
                for _ in 0..length {
                    self.skip(element)?;
                }
                Some(())
            }
            10 => loop {
                let inner = self.u8()?;
                if inner == 0 {
                    return Some(());
                }
                self.string()?;
                self.skip(inner)?;
            },
            11 => {
                let length = self.i32()?.max(0) as usize;
                self.take(length.checked_mul(4)?).map(|_| ())
            }
            12 => {
                let length = self.i32()?.max(0) as usize;
                self.take(length.checked_mul(8)?).map(|_| ())
            }
            _ => None,
        }
    }
}

fn parse(data: &[u8]) -> Option<Vec<ServerEntry>> {
    let mut reader = Reader { data, pos: 0 };
    if reader.u8()? != 10 {
        return None;
    }
    reader.string()?; // Name des Wurzel-Compounds ist leer.

    let mut servers = Vec::new();
    loop {
        let tag = reader.u8()?;
        if tag == 0 {
            break;
        }
        let name = reader.string()?;
        if tag == 9 && name == "servers" {
            let element = reader.u8()?;
            let length = reader.i32()?;
            if !(0..=MAX_SERVERS).contains(&length) {
                return None;
            }
            for _ in 0..length {
                if element == 10 {
                    servers.push(parse_server(&mut reader)?);
                } else if element != 0 {
                    reader.skip(element)?;
                }
            }
        } else {
            reader.skip(tag)?;
        }
    }
    Some(servers)
}

fn parse_server(reader: &mut Reader) -> Option<ServerEntry> {
    let mut entry = ServerEntry::default();
    loop {
        let tag = reader.u8()?;
        if tag == 0 {
            break;
        }
        let key = reader.string()?;
        match (tag, key.as_str()) {
            (8, "name") => entry.name = reader.string()?,
            (8, "ip") => entry.ip = reader.string()?,
            _ => reader.skip(tag)?,
        }
    }
    Some(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<ServerEntry> {
        vec![
            ServerEntry {
                name: "SMP".into(),
                ip: "play.example.net".into(),
            },
            ServerEntry {
                name: "Welt 🌍".into(),
                ip: "1.2.3.4:25565".into(),
            },
        ]
    }

    #[test]
    fn roundtrip_keeps_names_and_ips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        assert_eq!(write(&path, &sample()).unwrap(), 2);

        let mut read_back = read(&path);
        read_back.sort_by(|left, right| left.ip.cmp(&right.ip));
        assert_eq!(read_back.len(), 2);
        assert_eq!(read_back[0].name, "Welt 🌍");
        assert_eq!(read_back[0].ip, "1.2.3.4:25565");
        assert_eq!(read_back[1].name, "SMP");
    }

    #[test]
    fn sync_adds_launcher_servers_and_keeps_game_only_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        write(
            &path,
            &[ServerEntry {
                name: "Nur im Spiel".into(),
                ip: "game-only.example".into(),
            }],
        )
        .unwrap();

        let report = sync(&path, &sample()).unwrap();
        assert_eq!(report.written, 3);
        assert_eq!(report.kept, 1);

        let entries = read(&path);
        assert!(entries
            .iter()
            .any(|entry| entry.ip == "game-only.example" && entry.name == "Nur im Spiel"));
        assert!(entries.iter().any(|entry| entry.ip == "play.example.net"));
    }

    #[test]
    fn sync_updates_the_name_of_a_known_server() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        write(
            &path,
            &[ServerEntry {
                name: "Alt".into(),
                ip: "play.example.net".into(),
            }],
        )
        .unwrap();

        sync(
            &path,
            &[ServerEntry {
                name: "Neu".into(),
                ip: "play.example.net".into(),
            }],
        )
        .unwrap();

        let entries = read(&path);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "Neu");
    }

    #[test]
    fn missing_or_corrupt_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        assert!(read(&path).is_empty());

        std::fs::write(&path, b"not gzip").unwrap();
        assert!(read(&path).is_empty());

        std::fs::create_dir_all(dir.path().join("sub")).unwrap();
        let nested = dir.path().join("sub").join(FILE_NAME);
        let report = sync(&nested, &sample()).unwrap();
        assert_eq!(report.written, 2);
        assert!(nested.is_file());
    }

    #[test]
    fn blank_ips_are_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let entries = vec![
            ServerEntry {
                name: "Leer".into(),
                ip: "   ".into(),
            },
            ServerEntry {
                name: "Echt".into(),
                ip: "host".into(),
            },
        ];
        assert_eq!(write(&path, &entries).unwrap(), 1);
        assert_eq!(read(&path).len(), 1);
    }
}
