//! Minecraft-Serverliste-Ping: Handshake, Status-Anfrage, Status-Antwort.
//!
//! Jeder Ping hat ein festes Zeitbudget. Die Adresse wird selbst aufgelöst und
//! IPv4 zuerst verbunden: ein IPv6-Ziel ohne Route darf den Ping nicht
//! auffressen. Auch die Antwort hat ein eigenes Limit – ein Port, der die
//! Verbindung annimmt und dann schweigt, blockiert die Oberfläche nicht mehr.

use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const DNS_BUDGET: Duration = Duration::from_secs(2);
const CONNECT_BUDGET: Duration = Duration::from_secs(2);
const RESPONSE_BUDGET: Duration = Duration::from_secs(3);
const TOTAL_BUDGET: Duration = Duration::from_secs(6);

/// Pingt eine Adresse (`host`, `host:port` oder `[::1]:port`).
pub async fn ping(address: &str) -> Result<Value, String> {
    tokio::time::timeout(TOTAL_BUDGET, ping_within(address))
        .await
        .map_err(|_| "Zeitüberschreitung".to_string())?
}

async fn ping_within(address: &str) -> Result<Value, String> {
    let (host, port) = split_address(address);
    if host.trim().is_empty() {
        return Err("Keine Adresse".to_string());
    }

    let mut stream = connect(&host, port).await?;

    let mut handshake = Vec::new();
    write_varint(&mut handshake, 0x00);
    write_varint(&mut handshake, 767);
    write_varint(&mut handshake, host.len() as i32);
    handshake.extend_from_slice(host.as_bytes());
    handshake.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut handshake, 1);
    let mut packet = Vec::new();
    write_varint(&mut packet, handshake.len() as i32);
    packet.extend_from_slice(&handshake);
    // Status-Anfrage: Länge 1, Paket-ID 0.
    packet.extend_from_slice(&[0x01, 0x00]);

    let started = Instant::now();
    stream
        .write_all(&packet)
        .await
        .map_err(|error| error.to_string())?;
    let text = tokio::time::timeout(RESPONSE_BUDGET, read_status(&mut stream))
        .await
        .map_err(|_| "Zeitüberschreitung".to_string())??;
    let latency = started.elapsed().as_millis() as u64;

    let status: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    Ok(json!({
        "online": true,
        "playersOnline": status.pointer("/players/online").and_then(Value::as_u64).unwrap_or(0),
        "playersMax": status.pointer("/players/max").and_then(Value::as_u64).unwrap_or(0),
        "motd": motd(&status),
        "ping": latency,
        "version": status.pointer("/version/name").and_then(Value::as_str).unwrap_or(""),
        "icon": status.get("favicon").and_then(Value::as_str),
    }))
}

fn split_address(address: &str) -> (String, u16) {
    let address = address.trim();
    if let Some(rest) = address.strip_prefix('[') {
        if let Some((host, tail)) = rest.split_once(']') {
            let port = tail
                .strip_prefix(':')
                .and_then(|port| port.parse().ok())
                .unwrap_or(25565);
            return (host.to_string(), port);
        }
    }
    match address.rsplit_once(':') {
        Some((host, port))
            if !host.contains(':')
                && !port.is_empty()
                && port.chars().all(|ch| ch.is_ascii_digit()) =>
        {
            (host.to_string(), port.parse().unwrap_or(25565))
        }
        _ => (address.to_string(), 25565),
    }
}

async fn connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let resolved = tokio::time::timeout(DNS_BUDGET, tokio::net::lookup_host((host, port)))
        .await
        .map_err(|_| "Namensauflösung zu langsam".to_string())?
        .map_err(|error| format!("Adresse nicht gefunden: {error}"))?;
    let mut addresses: Vec<std::net::SocketAddr> = resolved.collect();
    if addresses.is_empty() {
        return Err("Adresse nicht gefunden".to_string());
    }
    // IPv4 zuerst: ohne funktionierende IPv6-Route würde sonst jede Adresse
    // ihr Zeitlimit verbrauchen, bevor der erreichbare Eintrag dran ist.
    addresses.sort_by_key(|address| !address.is_ipv4());

    let mut last_error = "Verbindung fehlgeschlagen".to_string();
    for address in addresses {
        match tokio::time::timeout(CONNECT_BUDGET, TcpStream::connect(address)).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Ok(Err(error)) => last_error = error.to_string(),
            Err(_) => last_error = "Zeitüberschreitung".to_string(),
        }
    }
    Err(last_error)
}

/// Liest die Status-Antwort: Länge, Paket-ID, JSON-String.
async fn read_status<R: AsyncRead + Unpin>(reader: &mut R) -> Result<String, String> {
    let length = read_varint(reader).await?;
    if length <= 0 || length > 4 * 1024 * 1024 {
        return Err("Ungültige Antwort".to_string());
    }
    let mut body = vec![0u8; length as usize];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|error| error.to_string())?;

    let mut cursor = 0usize;
    let _packet_id = read_body_varint(&body, &mut cursor)?;
    let json_len = read_body_varint(&body, &mut cursor)? as usize;
    let end = (cursor + json_len).min(body.len());
    Ok(String::from_utf8_lossy(&body[cursor..end]).to_string())
}

fn motd(status: &Value) -> String {
    match status.get("description") {
        Some(Value::String(text)) => text.clone(),
        Some(value) => {
            let mut text = value
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if let Some(extra) = value.get("extra").and_then(Value::as_array) {
                for part in extra {
                    if let Some(part) = part.get("text").and_then(Value::as_str) {
                        text.push_str(part);
                    }
                }
            }
            text
        }
        None => String::new(),
    }
}

fn write_varint(out: &mut Vec<u8>, mut value: i32) {
    loop {
        let byte = (value & 0x7F) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

async fn read_varint<R: AsyncRead + Unpin>(reader: &mut R) -> Result<i32, String> {
    let mut result = 0i32;
    for shift in 0..5 {
        let byte = reader.read_u8().await.map_err(|error| error.to_string())?;
        result |= ((byte & 0x7F) as i32) << (shift * 7);
        if byte & 0x80 == 0 {
            return Ok(result);
        }
    }
    Err("VarInt zu lang".to_string())
}

fn read_body_varint(body: &[u8], cursor: &mut usize) -> Result<i32, String> {
    let mut value = 0i32;
    for shift in 0..5 {
        let byte = *body.get(*cursor).ok_or("Antwort zu kurz")?;
        *cursor += 1;
        value |= ((byte & 0x7F) as i32) << (shift * 7);
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err("VarInt zu lang".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_uses_the_smallest_form() {
        let mut small = Vec::new();
        write_varint(&mut small, 127);
        assert_eq!(small, vec![0x7F]);

        let mut large = Vec::new();
        write_varint(&mut large, 255);
        assert_eq!(large, vec![0xFF, 0x01]);
    }

    #[test]
    fn splits_hosts_ports_and_ipv6() {
        assert_eq!(
            split_address("play.example.com"),
            ("play.example.com".to_string(), 25565)
        );
        assert_eq!(
            split_address(" 1.2.3.4:25566 "),
            ("1.2.3.4".to_string(), 25566)
        );
        assert_eq!(split_address("[::1]:25567"), ("::1".to_string(), 25567));
        assert_eq!(split_address("::1"), ("::1".to_string(), 25565));
    }
}
