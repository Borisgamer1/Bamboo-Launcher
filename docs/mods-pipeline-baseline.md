# Mods-Pipeline — Baseline (Roadmap-Phase 0)

Aufgezeichnete Messreihe der Mod-Pipeline gegen den Stand nach Phase 6. Sie ist der
Vergleichspunkt für jeden späteren Lauf: **Zahlen sind Bereiche mit Streuung, keine
Punktwerte.** Ein einzelner Wall-Clock-Wert auf dieser Maschine ist nicht
reproduzierbar (siehe „Vergleich mit den früher berichteten Werten“), also behauptet die
Datei auch keinen.

Reiner Messstand: keine Produktfunktion, keine UI/IPC-Verdrahtung.

## Aufruf

```bash
npm run bench:mods -- --baseline --runs 5      # diese Reihe
node --expose-gc bench/mods-bench.cjs --baseline --runs 5
node --expose-gc bench/mods-bench.cjs          # Phase-6-Lauf: 1.000 Mods, Resolver, 10 Installationen, langsames Netz
```

Der Treiber liegt in `bench/mods-bench.cjs` (bewusst außerhalb von `scripts/`, weil
dieses Repo laut `.gitignore` ein Backend-only-Repo ist und `scripts/` nicht
versioniert). Er hängt nur an `dist-electron`, also vorher `npm run build:core`
beziehungsweise `npm run bench:mods` verwenden.

## Messmethode

- **Fixture je Größe** (50 / 250 / 1.000 JARs): 65 % unverändert, 10 % lokal geändert
  (absichtlich veralteter Hash **und** veraltete mtime, damit der Fast Path sie nicht
  überspringt), 20 % unbekannt (nur auf der Platte, ohne Ledger-Eintrag), 5 % fehlend
  (Ledger-Eintrag ohne Datei). Die JARs tragen ~3 KiB inkompressiblen Füllstoff, damit
  Hashing Bytes misst und nicht Wiederholung.
- **Echte Pfade, keine Nachbildung:** `scanMissingDependencies` (Metadatenleser),
  `hashFileDual` (SHA-1 + SHA-512 in einem Durchlauf), `checkInstalledUpdates` auf
  einem `ModLedger` gegen einen lokalen Provider-Server, und der Streaming-Download
  (50 MB) über `streamToFile` mit dem Metrics-Hook.
- **Wiederholungen:** jede Kombination `--runs` mal (hier 5). Jeder „kalte" Durchlauf
  schreibt das Fixture-Ledger neu und liest es mit einer **frischen** `ModLedger`-Instanz;
  eine bereits geladene Instanz würde ihre Einträge cachen und den Lauf heimlich warm machen.
- **Ausgabe:** pro Zeitwert `min–max ms (median)`. RSS ist der höchste während der Phase
  gemessene Wert (Abtastung alle 20 ms, Basis = RSS nach `gc()` davor), ebenfalls als Bereich.
- **Invarianten:** die Zählwerte (geparste Mods, gehashte Bytes, geprüft/gecacht/gehasht,
  Requests, Status-Verteilung) müssen über alle Wiederholungen identisch sein. Weicht einer ab,
  druckt der Treiber `VARIES` und beendet sich mit Exit-Code 1 — ein schwankender Zähler ist ein
  Defekt, kein Rauschen. Letzter Lauf: **25/25 Invarianten gehalten**.

## Maschine und Datum

| | |
|---|---|
| Aufnahme | 2026-10-26T17:33:25Z, 5 Wiederholungen je Kombination (ein gleichartiger Lauf um 17:31:42Z diente als Streuungsprobe) |
| Plattform | win32 x64, Windows 10.0.26300 |
| CPU | AMD Ryzen 7 5700G, 16 logische Kerne |
| RAM | 31,9 GiB |
| Node | v24.16.0 (npm 11.19.1) |
| Repo-Stand | Arbeitsbaum nach Phase 6, damaliger Stand vor 0.2.0 |

## Ergebnisse

### Scan, Hashing und Update-Check (`min–max ms`, median in Klammern)

| Messpunkt | 50 JARs (48 auf Platte, 40 Ledger) | 250 JARs (238 / 200) | 1.000 JARs (950 / 800) |
|---|---|---|---|
| Scan (5 Läufe) | 50–53 (50) | 216–242 (224) | 823–937 (841) |
| Hashing aller JARs (5 Läufe) | 47–55 (49) | 239–251 (242) | 877–957 (935) |
| gehashte Menge | 157 KiB / 48 Dateien | 780 KiB / 238 Dateien | 3,04 MiB / 950 Dateien |
| Update-Check kalt (5 Läufe) | 21–75 (22) | 44–51 (48) | 130–142 (135) |
| Update-Check warm (5 Läufe) | 6–6 (6) | 25–26 (26) | 91–102 (98) |
| Update-Check warm + `refresh` (5 Läufe) | 19–20 (20) | 44–51 (45) | 133–142 (138) |
| Kalt: gehasht / gecacht / geprüft | 5 / 0 / 40 | 25 / 0 / 200 | 100 / 0 / 800 |
| Kalt: Requests (Batches à 100) | 1 | 2 | 7 |
| Kalt: Status | up-to-date 33, local-change 5, missing 2 | 163 / 25 / 12 | 650 / 100 / 50 |
| Warm: gehasht / gecacht | 5 / 33 | 25 / 163 | 100 / 650 |
| Warm: Requests | 0 | 0 | 0 |
| Refresh: gehasht / Requests | 5 / 1 | 25 / 2 | 100 / 7 |
| RSS-Peak Scan | 68,4–68,8 MiB | 89,3–93,8 MiB | 124,1–152,8 MiB |
| RSS-Peak Hashing | 73,4–74,7 MiB (+0,9) | 102,1–110,8 MiB (+7,3) | 174,6–202,1 MiB (+23,4) |
| RSS-Peak Check kalt | 76,1–95,2 MiB | 96,8–97,5 MiB | 154,8–156,0 MiB |
| RSS-Peak Check warm | 78,0–78,3 MiB | 96,2–97,0 MiB | 153,8–155,3 MiB |

### Streaming-Download 50 MB (lokaler Server, keine künstliche Verzögerung, 5 Läufe)

| Messpunkt | Wert |
|---|---|
| Wandzeit | 304–316 ms (median 311) |
| Durchsatz | 158,2–164,5 MiB/s (median 160,8) |
| Bytes heruntergeladen / auf Platte / von der Telemetrie gezählt / gehasht | je 50,00 MiB (identisch in allen Läufen) |
| RSS-Peak | 182,5–212,5 MiB (median 185,4, Basis 172,8, +12,6) |

## Vergleich mit den früher berichteten Werten

Die erste Phase-0-Reihe wurde als Punktwerte berichtet (2 Läufe je Kombination). Sie ist
**überholt**: die Nachmessung in einem anderen Prozess lag bei 1.000 JARs um +15 %/+34 %
daneben (Hashing 1.077/1.232 ms statt 934/918 ms), beim Kalt-Check um +15 %/+13 %
(177/163 ms statt 154/144 ms). Der Hashing-Wert für 1.000 JARs ist damit ehrlich als
**~0,86–1,23 s** zu lesen, nicht als 0,9 s.

| Messpunkt | früher berichtet (Punktwert) | diese Reihe (Bereich, median) | belastbare Spanne |
|---|---|---|---|
| Scan 50 / 250 / 1.000 JARs | 55 / 232 / 858 ms | 50–53 / 216–242 / 823–937 | ±10 % |
| Hashing 50 / 250 / 1.000 JARs | 55 / 231 / 934 ms | 47–55 / 239–251 / 877–957 | 50/250 ±10 %, 1.000 **−6 % bis +32 %** |
| Check kalt 50 / 250 / 1.000 JARs | 79 / 45 / 154 ms | 21–75 / 44–51 / 130–142 | 250 ±13 %, 1.000 ±15 %, 50 bis −73 % (Aufwärmeffekt) |
| Check warm 50 / 250 / 1.000 JARs | 6 / 23 / 102 ms | 6 / 25–26 / 91–102 | ±15 % |
| Download 50 MB | 401 ms, 124,7 MiB/s | 304–316 ms, 158,2–164,5 MiB/s | −24 % bis +40 % |

**Was reproduzierbar ist:** jede Strukturzahl — gehashte/gecachte/geprüfte Einträge, Requests,
Status-Verteilung, angefragte Hashes (10 Batching-Aufrufe / 330 Hashes bei 50 JARs,
20 / 1.630 bei 250, 70 / 6.500 bei 1.000) und die 50-MB-Bytezahlen. Sie sind in jedem Lauf
identisch und der Treiber scheitert, wenn nicht.

**Was nicht reproduzierbar ist:** jede Millisekunde. Die Streuung innerhalb eines Prozesses ist
klein (median ±5 %), über Prozesse/Zeitpunkte groß (bis +34 %) — Dateisystem-Cache, Virenscanner
und CPU-Takt wirken mit. Die beiden gleichartigen 5-Lauf-Reihen dieses Tages belegen das direkt:
Hashing bei 1.000 JARs 855–909 ms (17:31:42Z) gegen 877–957 ms (17:33:25Z), Kalt-Check bei
50 JARs 20–79 ms gegen 21–75 ms. Aussagen wie „Phase 6 ist X % schneller" sind deshalb nur mit
Toleranz zu treffen.

## Was diese Reihe nicht zeigt

- Eine Maschine, kein CI, kein Vergleich gegen die vorherige Engine — die Baseline sagt nichts
  darüber aus, ob die neue Pipeline schneller ist als der alte Pfad, nur wie sie sich jetzt verhält.
- Die Phase-6-Benchmarks (1.000-Mod-Auflösung, 10 parallele Installationen, langsames Netz,
  Telemetrie-Snapshot) sind hier nicht wiederholt; dafür `npm run bench:mods` ohne `--baseline` fahren.
- Kalte Requests gegen die echten Provider-APIs sind nicht enthalten (nur der lokale Fixture-Server);
  Netz- und Ratenlimit-Effekte fehlen damit bewusst.
- Die Telemetrie wird pro Prozess geführt; die Reihe liest pro Lauf eine eigene `ModMetrics`-Instanz.
  Im laufenden Launcher füllt den gemeinsamen Zähler `modsMetrics`, abrufbar über
  `modsMetricsSnapshot()` (kein IPC nötig).
