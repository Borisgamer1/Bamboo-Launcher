# Bamboo Client — REA von Velo Client & Gesamtkonzept

Stand: 13. November 2026 · Grundlage: lokal installierter **Velo Client Launcher 1.4.0**
(`C:\Program Files\Velo Client Launcher`) und **velo-client-26.2.jar** aus der laufenden
Instanz. Alles hier ist aus dem ausgelieferten Programm gelesen (Klassen, Ressourcen,
Konfigurationen, Store-Katalog), nicht aus Behauptungen oder Screenshots.

**Die eine Entscheidung vorweg:** Der Bamboo Client wird **keine zweite App**. Er ist ein
globaler Modus im bestehenden Launcher, umgeschaltet über einen Schalter unten in der
Sidebar über „Einstellungen“. Ist er an, zeigt der Launcher Store und Locker, und beim
Start bekommt die Instanz temporär die Client-Mod plus Performance-Mods. Ist er aus, ist
alles wie heute – die Mods bleiben liegen, werden nur deaktiviert.

---

## 0. Kurzfassung

| Punkt | Ergebnis |
| --- | --- |
| Velo-Launcher | JavaFX 21, eine 356-MB-`launcher.jar`, eigenes Java 25, gebündelte Vanilla-Jars, Modrinth-Installer, Doctor/Crash-Analyse, Store, Cosmetics, Social |
| Velo-Mod | Fabric, 69 MB, 2.780 Einträge, **129 Module**, MIT-Lizenz, Mojang-Mappings, Mixins für HUD/Menü/Render |
| Wiederverwendbar | Modulsystem, HUD-Layout, Menü-/Widget-Baukasten, Zoom, Minimap, Weltkarte, Store-Aufbau, Kosmetik-Pipeline, Performance-Mod-Liste, Animationstokens |
| Nicht wiederverwendbar | Velo-Assets (Wings-Meshes, Store-Art, Sounds), Velo-Backend, Velo+-Paywall, Namensraum |
| Bamboo-Umfang | Client-Schalter, In-Game-Menü, HUD-Tiles, Zoom, Minimap, Weltkarte, Wings/Capes/Wear/Auras/Pets/Emotes/KillFX, Store, Performance-Paket |
| Preis | Bamboo bleibt komplett kostenlos. Store arbeitet mit verdienten Bamboo-Coins, kein Echtgeld-Zwang, keine Paywall für Gameplay |
| Aufwand MVP | ca. 10–14 Wochen für eine erfahrene Person (Details in §11) |

---

## 1. Was da eigentlich installiert ist

### 1.1 Velo Client Launcher

```
C:\Program Files\Velo Client Launcher\
  Velo Client Launcher.exe        576 KB   jpackage-Stub
  runtime\                        162 MB   Java 25 (JRE, kein javac)
  app\
    launcher.jar                  356 MB   kompletter Launcher + Assets + Game-Jars
    gson / javafx / webp-imageio           Abhängigkeiten
    Velo Client Launcher.cfg               Main-Class net.veloclient.launcher.LauncherApp
```

In der `launcher.jar` stecken unter anderem:

- `net/veloclient/launcher/ui/**` — 160+ JavaFX-Klassen (Screens, Widgets, 3D-Previews)
- `net/veloclient/launcher/data/**` — Kataloge, Stores, Settings, Profile
- `net/veloclient/launcher/launch/**` — Installer, Performance-Mods, Plus-Addons, Doctor
- `net/veloclient/launcher/gamejars/` — Vanilla-Jars für 1.8.9, 1.21.1, 1.21.10, 1.21.11, 26.1–26.3
- `net/veloclient/launcher/javaruntime/` — Bootstrap-Stub
- `net/veloclient/launcher/wings/` — 8 `.vmesh`-Modelle + Texturen + `wings.json`
- `net/veloclient/launcher/pets/` — 19 Pet-Previews
- `net/veloclient/launcher/killfx/` — 15 Sounds
- `net/veloclient/launcher/store/cape/` — 4 animierte GIF-Capes
- `net/veloclient/launcher/fonts/` — 20 Fonts (Geist, Sora, Inter, JetBrains Mono, Monocraft, Audiowide …)
- `net/veloclient/velo/client/**` — JavaFX-Preview-Code für Wings, Auras, KillFX, Namestyles

Der Launcher ist kein Electron: reines JavaFX mit eigener Fensterdekoration
(`WindowChrome`, undecorated, selbstgezeichnete Minimieren/Maximieren/Schließen-Buttons,
8-px-Resize-Kanten, animiertes Maximieren über 180 ms).

### 1.2 Velo Client Mod

```
%APPDATA%\VeloClient\instances\<uuid>\mods\velo-client-26.2.jar
  69.341.769 Bytes · 2.780 Einträge
  fabric.mod.json: id velo-client, version 1.4.0+26.2, license MIT,
                   environment client, java >= 25, minecraft ~26.2
  LICENSE_velo-client: MIT, Copyright (c) 2026 Velo Client Contributors
```

Package-Verteilung (Klassen):

| Package | Klassen | Inhalt |
| --- | --- | --- |
| `client/gui` | 256 | Menüs, HUD-Editor, Store, Locker, Schematics, Clips, Widgets |
| `client/modules` | 203 | 129 Module in 10 Kategorien |
| `client/mixin` | 191 | HUD, Menü, Render, Input, Chat, Titelbildschirm |
| `client/cosmetics` | 134 | Wings, Capes, Wear, Auras, KillFX, Pets, Loadouts |
| `client/redstone` | 68 | Redstone-Mode-Overlay (Tick-/Signal-Analyse) |
| `client/network` | 33 | eigenes Backend/Store/Social |
| `client/clips` | 29 | Replay-Buffer, FFmpeg, WASAPI-Audio, Clip-Share |
| `client/emotes` | 26 | Emote-Katalog, Rad, Props, Sounds |
| `client/levelmap` | 18 | Weltkarte, Regionen, LOD, Waypoints |
| `client/hud` | 15 | HUD-Manager, Position, Auto-Layout, Frame-Cache |
| `client/waypoints`, `theme`, `store`, `namestyle`, `stats`, `crosshair`, `keybind`, `profile` | je 5–9 | Rest |

### 1.3 Datenlayout (wichtig für unsere eigene Struktur)

```
%APPDATA%\VeloClient\
  config\
    launcher-settings.json     RAM, GC, Memory-Guard, Performance-Mode, Auto-Update
    theme.json                 Theme-Name + Farb-Overrides
    quick-toggles.json         Favoriten/Recent der Pause-Schnellschalter
    menu-key.json              Öffnen-Taste des In-Game-Menüs (Default: Grave/`)
    name-style-viewer.json     wo Namestyles animiert werden
    plus-badge.json            Velo+-Badge an/aus
    waypoints-v2.json          Waypoints + Weltnamen
  cache\cosmetics\
    catalog.json               150 Items, 11 Collections, featured
    files\<sha256>             Texturen, Meshes, GIFs, Sheets, Animationen
  capes\*.velocape             eigene Capes
  crosshairs\<uuid>\           eigener Crosshair-Editor
  gamedata\                    Libraries, Assets, Versionen
  instances\<uuid>\
    instance.json              Name, MC-Version, Icon, createdAt
    mods\velo-client-26.2.jar
    config\velo-client\        experimental-mods.properties, auto-vulkan.txt
    config\gnetum.json         Default-Config des Performance-Mods
    worldmap\ (Mod)            Regionen der Weltkarte
```

Die Mod legt ihren State **relativ zum Game-Dir der Instanz** ab, nicht im AppData des
Launchers. Das ist der saubere Weg: eine Instanz = ein vollständiger Zustand, und der
Launcher kann ihn lesen/schreiben.

### 1.4 Lizenzfazit (entscheidend für die Umsetzung)

- Der **Code** der Mod steht unter MIT. Übernahme, Fork, Veränderung und Auslieferung sind
  erlaubt, solange Copyright- und Lizenzhinweis mitkommen. Wir müssen also nichts
  „nachbauen, ohne zu schauen“ — wir dürfen den Modul-/HUD-/Menü-Unterbau als Vorlage
  nehmen und auf Bamboo umschreiben.
- Die **Assets** (Wings-Meshes, Store-Karten, Capes, Pet-Sheets, Sounds) sind nicht
  automatisch MIT. Wir übernehmen **keine** Velo-Dateien, sondern bauen eigene Modelle,
  Texturen und Sounds. Das ist auch produktstrategisch besser: Bamboo soll nach Bamboo
  aussehen, nicht wie ein Velo-Klon.
- Der Launcher (JavaFX) ist **nicht** MIT. Wir lesen ihn nur als Referenz für Abläufe,
  Dateiformate und UX; Code daraus wandert nicht in Bamboo.

---

## 2. Feature-Landkarte aus der REA

Bewertung: **Ü** = übernehmen, **A** = anpassen, **S** = später, **N** = nicht übernehmen.

### 2.1 Launcher-Oberfläche und Animationen

| Fund | Detail | Bamboo |
| --- | --- | --- |
| Splash-Intro | Logo-Pop 280 ms Back-Out, Ringe 320 ms, Buchstaben 30 + i·28 ms, Reveal 380–460 ms | **Ü** als Start-Animation, kürzer (max. 1,2 s) |
| Seitenwechsel | Fade 200 ms + Slide 10–22 px + Scale 0,992→1, Ease-Out 260–300 ms | **Ü** in React/Framer-Motion |
| Karten-Stagger | max. 24 Elemente, 240 ms Fade + 320 ms Rise, Delay 40 + i·35 ms | **Ü** für Store-/Locker-Grids |
| Hover | Scale 1,012 (Karten) / 1,025 / 1,05, 140 ms; Press 0,955 in 70 ms; Release 160 ms | **Ü** als Motion-Tokens |
| Fenster | Undecorated, eigene Buttons, Maximieren animiert 180 ms | **A** Tauri macht das nativ; nur Kurven/Timing übernehmen |
| Hintergrund | Canvas: Glow, 48-px-Grid, schwebende Embers, isometrische Cubes | Bamboo hat Partikel; **A** optional Grid+Embers |
| Theme | `Theme(name, background, surface, accentStart, accentEnd, text, radius, blur, animationSpeed, panelOpacity)` | **Ü** als Erweiterung der Bamboo-Themes |
| Home-Suche | globale Suche über Module/Screens | **A** Bamboo hat Command-Palette |

Gemessene Bewegungswerte (übernehmen wir 1:1 als Tokens):

```
Ease-Out        cubic-bezier(0.2, 0.8, 0.25, 1)
Back-Out        s = 1.70158 (Karten) / 0.9 (weich)
Hover           140 ms, Scale 1.012 / 1.025 / 1.05
Press           70 ms, Scale 0.955
Release         160 ms
Screen enter    200 ms Fade + 260–300 ms Rise
Stagger         40 ms Start + 35 ms pro Element, max. 24
Splash          280 / 320 / 380 / 460 ms
In-Game Pause   320 ms, 1-(1-t)^3
HUD-Smoothing   exp(-12·dt)
```

### 2.2 Module (129)

Kategorien und vollständige, nutzerseitige Liste (Helferklassen weggelassen):

**Performance (30)** — Performance Boost (Presets Auto/Default/Max FPS/Medium/High),
Cosmetics Quality (High/Medium/Low, GPU-Cosmetics), Dynamic FPS, Entity Detail,
Entity View Cache, FOV, Frame Time Graph, Full Bright, GPU Utilization, HUD Cache Tuner,
Input Sampler (+Thread), Memory Monitor, Particle Limiter, Render Culling, Seamless Reload,
Shader Cache, Sodium Visibility, Threaded/Decoupled Present, Video Options,
Auto Vulkan, Alternate Current, C2ME, Anti-Farm-Lag (+Compat), Poly Blur, Deferred Sky,
Pass Barriers, Vulkan Pipeline Cache.

**HUD (27)** — Action Bar Log, Armor Bar, Armor Durability, Boss Bar, Clock, Coordinates,
CPS, FPS, Hearts, Held Item, Hotbar, HUD Style, Hunger, Keystrokes, Media Player,
Minimap (+Manager), Mouse Buttons, Ping, Player Levels, Potion Timers, Scoreboard,
Server Overlays, Session Stats, Totem Counter, Waypoints, XP Bar.

**PvP (24)** — Arrow Counter, Auto GG, Combo Counter, Cooldowns, Damage Numbers,
Direction HUD, Enemy Effects, Enemy Hunger, Fight Recap, Health Indicator, Height Limit,
Hit Color, Hit Particles, Hit Sounds, Item Position, Low Fire, Low Health Warning,
Old Animations (+Input), Pot Counter, Reach Display, Speed HUD, Target HUD, Totem Pops.

**QoL (21)** — Anti-Coords-Leak, Attack Indicator, Centered Inventory, Chat Tweaks, Clips,
Custom Crosshair, Emoji Chat, Fly Speed, Free Look, Friends, Nick Hider, Own Name Tag,
Party Ping, Phantom, Shulker Preview, Small Caps, Toggle Sneak, Toggle Sprint,
Loading Screen, **Zoom**.

**Rendering (~15)** — Anti-Deepslate, Block Outline, Color Grading, Container Animations,
Container Slot View, Hide Foliage, Hold Up Items, No Break Particles, Particle Size,
Screen Stretch, Time/Weather Fog, TNT Timer, Velo Shaders (Compat/Lights/Passes/
Shadow Map/Shadow Entities/Should Draw).

**Server-Tools (15)** — Chunk Border, Chunk Load Profiler, Client Log Viewer,
Entity Count, Game Mode Presets, Hitbox Visualizer, Light Level, Packet Traffic,
Particle Debug, Radius Shapes, Simulation Distance, Spawn Radius, TPS/Tick Graph,
Visited Chunks, World Border.

**Debug (5)** — Better F3 (eigene Panels), Keybind Conflict Checker, Looking-At Inspector,
Module Profiler Overlay, Resource Reload Hotkey.

**Utility (8)** — Auto Reconnect, Command Keybinds, Copy Coordinates, Session Auto Fixer,
Velo Network, Background Queue (2 Module + Ghost Packets + Parser).

**Redstone (3)** — Fast Grow, Hopper Speed, Tick Journal; dazu ein kompletter
Redstone-Mode mit eigenem HUD (Signalstärken, Tick-Spuren, Panels).

**Cosmetics (5)** — Cape, Wings, Aura, Kill Effects, Emotes.

Jedes Modul hat: `id`, Anzeigename, Beschreibung, Kategorie, Safety-Tag
(`ALWAYS_SAFE` / `CHECK_SERVER_RULES`), Default an/aus, `onEnable`/`onDisable`,
Config-Felder und optional eine HUD-Position.

Config-Feldtypen (sealed interface, sehr gut nachbaubar):

```java
ToggleField(label, BooleanSupplier, Consumer<Boolean>)
SliderField(label, min, max, getter, setter, formatter)
ChoiceField(label, List<String>, getter, setter)
ColorField(label, getter, setter, includeAlpha)
KeybindField / ChordKeybindField
ComponentField(label, placeholder, getter, setter)
ActionButtonField(label, Runnable)
HeaderField(label)
```

### 2.3 In-Game-Menü

- Öffnen mit **`** (Grave), konfigurierbar (`menu-key.json`).
- Kein Vanilla-Screen: eigener Screen mit **Rail** links (Icons + Labels + Tastenkürzel),
  Suche oben, Karten-Grid rechts, Kategorie-Überschriften mit Zähler.
- Rail-Einträge: **Modules**, Addons, **Locker**, Friends, Clips & Screenshots,
  **Fight Recap (K)**, **World Map (M)**, Waypoints, Background Queue, Schematics,
  **Settings**, Redstone Mode (R), Profiles, Cloud Sync (Velo+), World Hosting (Velo+).
- Modul-Karte: Icon, Name, Kurzbeschreibung, Toggle, Klick öffnet Config-Screen.
- Alles in einem Glass-Look: `panel()` mit Radius 9, Hairlines, Akzentfarbe,
  abgerundete Toggles, Hover-Slide von 2–3 px, Key-Hints in Mono.
- Der Screen animiert beim Öffnen (Fade + Rise) und die Karten gestaffelt.

### 2.4 HUD

- Jedes HUD-Modul implementiert `position()`, `width()`, `height()`, `render()`.
- Position als **Bruchteil** (0…1) plus Anker-Ecke; Skalierung 0,5–3,0; `placed`-Flag.
- **Auto-Layout**: nicht gesetzte Module werden gestapelt — Margin 2 px, Gap 2 px,
  top-right weicht Vanilla-Effektzeilen aus (26 px pro Zeile), right-side zentriert,
  top-center und bottom-right von unten nach oben. Update gedrosselt auf 50 ms.
- **HUD-Editor**: Drag verschiebt, Ecke unten rechts resized (live Prozent-Label),
  ×-Badge deaktiviert, Mittellinien beim Ziehen, Toolbar weicht Overlays aus,
  „Reset“, „HUD Style“, „Done“. Hover-Ring animiert mit `dt·1,6`.
- **HUD Style**: eine Font (Inter, Sora, Space Grotesk, Poppins, IBM Plex, JetBrains Mono,
  Audiowide, Minecraft), Hintergrund (None/Glass/Solid), Akzentfarbe, Shadow,
  rounded corners. Glass = `0xA0…`, Solid = `0xF0…`, Hairline `0x1CFFFFFF`.
- **Crash-Schutz**: wirft ein HUD-Modul beim Zeichnen, wird es abgeschaltet und ein Toast
  erklärt es. Kein Spiel-Crash durch ein Tile.
- **Frame-Cache**: HUD kann als Textur zwischengespeichert und wiederholt werden,
  wenn sich nichts geändert hat (wichtig für 240 fps).

HUD-Tiles, die wir bauen (Auswahl mit Defaults):

| Tile | Default | Inhalt |
| --- | --- | --- |
| FPS | an, top-left | FPS + 1%-Low, optional Frametime-Graph |
| CPS | an, left | links/rechts, Klick-Historie |
| Keystrokes | an, left | WASD + LMB/RMB + Space/Shift, gedrückt = Akzent |
| Coordinates | an, top-left | X/Y/Z, Dimension, Biome |
| Ping | an, top-right | ms + Balken |
| Armor | an, bottom-left | Rüstung + Haltbarkeit |
| Potions | an, top-right | Effekt, Stufe, Restzeit |
| Scoreboard | aus | eigenes Layout statt Vanilla |
| Boss Bar | aus | eigener Balken |
| Clock | aus | Ingame-/Realzeit |
| Session Stats | aus | Kills, Deaths, Blöcke, Distanz |
| Totem Counter | aus | Pops |
| Combo | aus | Hits in Folge |
| Reach | aus | letzter Trefferabstand |
| Target HUD | aus | Gegner-Name, HP, Rüstung |
| Pot Counter | aus | eigene/gegnerische Pots |
| Minimap | aus | §2.5 |
| Waypoints | aus | §2.5 |
| Media Player | aus | Now Playing |
| Server Overlays | aus | TPS, Spieler, Ping |

### 2.5 Zoom, Minimap, Weltkarte

**Zoom** (das sauberste Zoom, das ich in einem Client gesehen habe):

```
FOV 3–90 (Default 20)          In 110 ms / Out 130 ms
Scroll 12 % pro Raste          Maus-Sensitivität skaliert mit exp(logZoom)
Maus-Glättung 0–500 ms         FOV wird logarithmisch interpoliert
```

Technisch: `apply(vanillaFov)` rechnet über `tan(fov/2)` und `exp(logZoom)`, damit der
Zoom sich linear anfühlt; kurze Glide-Phase mit Cubic-Ease, danach exponentielle Annäherung.
Scrollen im Zoom ändert `currentZoomFov`; die Sensitivität wird nur während des Zooms
reduziert.

**Minimap**:

```
Größe 64–220 px (Default 128)   View-Radius 24–200 Blöcke (96)
Refresh 200–3000 ms (750)       Quadrat oder Kreis
Rotation mit Spieler an/aus     Spielerpfeil, Größe 3–18
Koordinaten + Himmelsrichtung   Kompass N/E/S/W im Kreis
Border-/Pfeilfarbe              Waypoint-Pins mit Item-Icons, am Rand angepinnt
```

Rendering: Vanilla-Kartenfarben werden in eine Textur gesampled
(`sampleRadius = max(viewRadius, viewRadius·1,5)`), die Textur wird für Rotation und
Zoom transformiert, runde Form über zeilenweise Scissor-Bänder. Waypoints werden
mitrotiert; außerhalb des Radius bleiben sie als Randpunkte sichtbar.

**Weltkarte**:

```
Region 256×256 Blöcke pro Datei   Layer: surface + cave0…caveN (16-Block-Bänder)
Chunk-Scan 8 pro Tick             Queue bei Chunk-Load, 5×5 Umkreis alle 100 Ticks
Biome 4×4-Zellen pro Chunk        Wasser wird nach Tiefe abgedunkelt
Speichern alle 600 Ticks          pro Welt/Dimension getrennt
LOD-Stufen für weit entfernte Regionen
```

Dazu: Vollbild-Screen mit Pan/Zoom, Layer-Umschalter, Waypoint-Liste, Teleport-Button
(nur wo erlaubt), Biom-Name unter dem Cursor, Party-Mitglieder als Marker.

### 2.6 Cosmetics (Velo-Mechanik)

Velo hat **7 Typen** und 150 Items in 11 Collections:

| Typ | Anzahl | Wie es funktioniert | Dateien |
| --- | --- | --- | --- |
| Wings | 16 | 3D-Mesh + Textur, Wingbeat je nach Zustand (idle/run/glide), Scale/Offset, Glow | `mesh`, `texture`, `preview` |
| Cape | 26 | Animiertes GIF als Frame-Textur, Physik-Presets, eigene Capes importierbar (`.velocape`) | `gif`, `card`, `card_of` |
| Aura | 26 | **Prozedural im Code** (Partikel/Emitter), nur Farbe/Größe/Geschwindigkeit als Settings | keine |
| Emote | 7 | Animation auf dem Spielermodell + Props + Sound, Emote-Rad (B halten) | `anim` |
| KillFX | 15 | Partikel-Burst + eigener Sound am Kill-Ort, in der eigenen Farbe | keine (Sound im Jar) |
| Wear | 42 | Mesh + Textur + Maske, an Knochen gebunden (`head`, `back`, `feet` …), links/rechts gespiegelt, einfärbbar | `mesh`, `mesh_l`, `texture`, `mask`, `preview` |
| Pet | 18 | Sprite-Sheet mit Animationen, folgt/steht/sitzt auf Schulter, feiert Kills | `sheet`, `preview` |

Wear-Slots: `head`, `ears`, `face`, `mask`, `neck`, `wrist`, `feet`, `back`.
Wear-Modell: `model.bone` + `model.mirror` (z. B. `rightLeg` → `leftLeg`), Tint pro Slot,
Tiefen-Offset nur für `face`/`mask`/`back`.

Katalogformat (aus `catalog.json`, 83 KB):

```json
{
  "featured": "afterlife",
  "collections": [
    { "id": "auras", "name": "Auras", "tag": "AURA COLLECTION", "description": "…" }
  ],
  "items": [
    {
      "id": "wings_angelic", "type": "wings", "name": "Angelic Wings",
      "description": "…", "price": 3000, "collection": "shadows_angels",
      "accent": "#f2d27a", "style": "feathered", "scale": 0.85,
      "offsetY": null, "glow": null,
      "files": { "texture": "<sha256>", "preview": "<sha256>", "mesh": "<sha256>" },
      "inStore": true, "availableUntil": null, "status": null,
      "slot": null, "model": null
    }
  ]
}
```

Dateien werden **über SHA-256** geladen (`/v1/cosmetics/file/<sha>`), maximal 12 MB,
Hash wird nach dem Download geprüft, atomar in `cache/cosmetics/files/<sha>` geschrieben.
Das ist ein gutes, robustes Muster — übernehmen wir.

Preise: 300–3.600 Coins, keine Rarity-Felder im Katalog (Rarity entsteht im Store-UI),
Bundles kommen vom Server, „Velo+“ ist ein eigenes Tab.

### 2.7 Store

Tabs: **Featured · Wings · Cloaks · Auras · Emotes · Kill FX · Bodywear · Bundles · Velo+**.

- Featured: großer Hero mit rotierendem 3D-Wings-Preview, „Buy“, „Try on“, Collection-Link.
- Karten: 3D-/2D-Preview, Name, Collection, Preis, Hover-Lift, Rarity-Rahmen.
- Detailseite: 3D-Preview mit Spin und Stage, Farb-/Größen-Settings, „Equip“, „Buy“,
  „Owned“-Zustand, „in Bundle enthalten“.
- Bundles: mehrere Items günstiger, eigenes Hero-Layout.
- Kauf: Bestätigungsdialog, Coin-Abzug, Ownership, Restore nach Neuinstallation.
- Velo+: 8 Perks (Hosting, Cloud-Sync, Clips Pro, Name Styles, animierte Cloaks,
  Home-Background, monatliche Coins, Badge/Discord).

### 2.8 Velo+ (bezahlte Features) — was davon wirklich cool ist

| Perk | Für Bamboo |
| --- | --- |
| World Hosting (Welt mit Freunden, ohne Portforwarding) | **S** eigenes Backend/Relay nötig |
| Cloud Sync (Settings, HUD, Profile, Waypoints, Keybinds + Restore-Punkte) | **A** lokal + optional Cloud später |
| Clips Pro (2–5 min Replay-Buffer, 1080p60, Auto-Clips, Share-Links) | **A** lokal als Replay-Buffer, Teilen später |
| Name Styles (animierte Gradienten/Rainbow/Glitch) | **Ü** komplett kostenlos |
| Animierte eigene Cloaks (GIF-Import) | **Ü** |
| Eigenes Home-Background-Bild/GIF | Bamboo hat Themes; **A** |
| Monatliche Coins | **N** (kein Abo) |
| Velo+-Badge / Discord-VIP | **A** „Supporter“-Badge, optional |

### 2.9 Performance-Paket (aus `PerformanceModsInstaller`)

Velo installiert pro Instanz automatisch:

```
sodium, lithium, ferrite-core, entityculling, immediatelyfast, modernfix,
gnetum, ixeris, cull-fewer-leaves, windows-priority-boost (nur Windows),
badoptimizations, better-block-entities, fabric-language-kotlin, fzzy-config,
particle-core, krypton, fast-ip-ping, wavey-capes
```

Opt-in (Flag in `config/velo-client/experimental-mods.properties`):
`c2me`, `alternate-current`, `distanthorizons`.

Legacy (1.8.9/Ornithe): `pylon`, `argentum`, `argentum-extras`, `cera`, `sarcio`,
`exploint`, `windows-priority-boost`.

Regeln, die wir übernehmen:

- State-Datei `velo-performance-mods.json` (welche Datei gehört zu welchem Slug/Version).
- Nur installieren, wenn die Mod nicht schon da ist (Mod-ID aus `fabric.mod.json`).
- Required Dependencies prüfen; sonst überspringen statt Start zu blockieren.
- Clashes: `cull-fewer-leaves` ↔ `moreculling`, `gnetum` ↔ `vulkanmod`,
  `sarcio` ↔ `zirconium`.
- `ixeris` auf Windows + MC 1.x unsicher → auslassen.
- Version wechselt → alte Dateien des Pakets entfernen, neu passend installieren.
- Default-Config für `gnetum` mitschreiben.
- Fehler beim Installieren dürfen den Start **nie** verhindern.

### 2.10 Andere coole Sachen, die wir noch nicht haben

- **Clips/Replay-Buffer** mit WASAPI-Loopback und FFmpeg-Encode (lokal, ohne Cloud).
- **Pets**, die mitlaufen und Kills feiern.
- **Emote-Rad** auf `B`.
- **Name Styles** in Chat/Tab/Nametag.
- **Eigene Crosshairs** mit Pixel-Editor.
- **Fight Recap** (K) — Runde aus Kills/Damage/HP als Zusammenfassung.
- **Server-Tools**: TPS-Graph, Chunk-Grenzen, Light-Level, Hitboxen, Packet-Traffic.
- **Redstone-Mode**: eigenes HUD für Signalstärken und Tick-Spuren.
- **Better F3** mit eigenen Panels, die man wie HUD-Tiles verschieben kann.
- **Waypoint-Share** per Code.
- **Schematics** (Litematica-Integration, Vorschau, Teilen).
- **Profile** pro Server (Module/HUD automatisch umschalten).
- **Quick Toggles** im Pause-Menü (Favoriten/Recent).
- **Memory Guard** (prüft freien RAM vor Start, warnt statt zu crashen).
- **Doctor/Crash-Analyse** mit gelernten Regeln — Bamboo hat Ansätze, Velo ist tiefer.

---

## 3. Bamboo Client: das Produkt

### 3.1 Ein Programm, ein Schalter

Kein zweiter Launcher, kein zweites Konto, kein separates Fenster. Der Client ist ein
**Modus** des Launchers:

```
┌──────────────────────────────────────────────────────────────┐
│  Bamboo Launcher                                             │
│                                                              │
│   Home   Instanzen   Mods   Anpassen   Multiplayer  …        │
│                                                              │
│   ────────────────────────────────                           │
│   [ Bamboo Client        ( ●━━ ) ]   ← Schalter              │
│   Einstellungen                                              │
└──────────────────────────────────────────────────────────────┘
```

- Der Schalter sitzt **unten in der Sidebar, direkt über „Einstellungen“**.
- Er ist global (nicht pro Instanz). Jeder Bamboo-Nutzer hat denselben Client.
- Ist er **an**, erscheinen zusätzlich: **Store**, **Locker** (Cosmetics), **Client**
  (Module/HUD/Performance) — und beim Start werden die Client-Dateien mitgegeben.
- Ist er **aus**, ist der Launcher exakt wie heute. Store/Locker/Client sind ausgeblendet,
  die Mods bleiben auf der Platte, werden aber nicht geladen.
- Der Zustand wird sofort gespeichert und überlebt Neustarts.

### 3.2 Was wann sichtbar ist

| Bereich | Client aus | Client an |
| --- | --- | --- |
| Home, Instanzen, Mods, Multiplayer, Screenshots | sichtbar | sichtbar |
| Anpassen → Skin | sichtbar | sichtbar |
| Anpassen → Cosmetics | sichtbar (Bamboo-Pakete) | sichtbar + „Im Client tragen“ |
| **Store** | **ausgeblendet** | **sichtbar** |
| **Locker** (Wings, Capes, Auras, Wear, Pets, Emotes, KillFX) | **ausgeblendet** | **sichtbar** |
| **Client** (Module, HUD, Performance, Menüs) | **ausgeblendet** | **sichtbar** |
| In-Game-Menü, HUD-Tiles, Zoom, Minimap, Weltkarte | nicht vorhanden | vorhanden |
| Cosmetics im Spiel sichtbar | nur alte Bamboo-Pakete, falls Mod da | alle, für andere Bamboo-Clients |
| Performance-Mods | nur wenn der Nutzer sie selbst installiert hat | automatisch, temporär |

### 3.3 Was „temporär reinmachen“ konkret heißt

Der Launcher fasst den `mods`-Ordner einer Instanz **nicht dauerhaft** an. Zwei Stufen:

**Stufe A — `fabric.addMods` (bevorzugt, standardmäßig):**

Fabric Loader unterstützt die Property seit **0.12** (Oktober 2021). Sie nimmt eine
Pfadliste, getrennt mit `;` auf Windows und `:` sonst, akzeptiert Jar-Dateien,
Ordner und eine `@`-Datei mit einem Pfad pro Zeile:

```text
java … -Dfabric.addMods=@C:\…\BambooLauncher\client\mods-26.2.txt

# mods-26.2.txt
C:\…\BambooLauncher\client\mods\bamboo-client-26.2.jar
C:\…\BambooLauncher\client\mods\sodium-0.9.2+mc26.2.jar
…
```

Die Jars liegen im Launcher-Cache, nicht in der Instanz. Beim Start werden sie nur
referenziert. Beim Beenden ist automatisch nichts mehr aktiv — nichts zu löschen,
nichts zu deaktivieren. Die `@`-Datei ist der saubere Weg für 18+ Mods; sie wird pro
MC-Version neu geschrieben. Fallback B bleibt für den unwahrscheinlichen Fall, dass
eine Loader-Version die Property ignoriert oder eine Mod sie nicht verträgt.

**Stufe B — Kopie mit Manifest (Fallback):**

```text
<instanz>/
  mods/                                  ← unverändert
  bamboo-client/
    managed.json                         { files: [{ name, sha256, slug }] }
    mods/                                ← nur unsere Jars
```

Kann Fabric keine externen Pfade laden, kopiert der Launcher die Jars in
`<instanz>/bamboo-client/mods` und startet mit diesem Pfad, oder — wenn auch das nicht
geht — in `mods/` mit einem Manifest. Dann gilt:

- Jede von uns gelegte Datei steht in `managed.json` (Name + Hash).
- Beim Ausschalten werden **nur** diese Dateien umbenannt: `x.jar` → `x.jar.disabled`.
- **Nichts wird gelöscht.** Beim nächsten Einschalten wird dieselbe Datei wieder
  aktiviert, nicht neu geladen.
- Fremde Mods werden nie angefasst. Kollidiert eine Fremd-Mod mit einer unseren
  (gleiche Mod-ID), gewinnt die Fremd-Mod und wir überspringen unsere.

**Nach dem Spielende** fragt der Launcher einmal:

```
Der Bamboo Client hat diese Instanz gestartet.
Performance-Mods wurden nur für diesen Start geladen.

[ Behalten ]   [ Deaktivieren ]   [ Nicht mehr fragen ]
```

- **Behalten** → Mods bleiben für die Instanz aktiv (Manifest bleibt).
- **Deaktivieren** → nur unsere Dateien werden `.disabled`, nichts gelöscht.
- **Nicht mehr fragen** → Entscheidung wird pro Instanz gespeichert.

### 3.4 Was der Client im Spiel kann (Zielbild)

1. **In-Game-Menü** auf `G` (änderbar): Module, Locker, Store-Link, Einstellungen,
   Waypoints, Map, Screenshots, Performance.
2. **HUD-Tiles** frei platzierbar, skalierbar, stylbar.
3. **Zoom** auf `C`, **Minimap** oben rechts, **Weltkarte** auf `M`.
4. **Cosmetics**: Wings, Capes, Auras, Wear, Pets, Emotes, KillFX, Name Styles.
5. **Performance**: Sodium-Stack + Presets, ohne dass der Nutzer Mods kennt.
6. **Server-Tools** und **PvP-HUD** nur als Opt-in, mit Safety-Tag „Serverregeln prüfen“.
7. **Alles rein clientseitig** — keine Vorteile, die ein Server als Cheat werten könnte
   (kein Reach, kein Fly, kein AutoClicker, keine Unsichtbarkeit).

---

## 4. Architektur

```
┌───────────────────────────── Bamboo Launcher (Tauri) ─────────────────────────────┐
│  React UI                                                                          │
│    Sidebar-Schalter · StoreView · LockerView · ClientView · Settings-Client-Tab    │
│                                   │ invoke()                                      │
│  Rust Core                        ▼                                                │
│    src/client/  state.rs  mods.rs  cosmetics.rs  store.rs  hud.rs  inject.rs       │
│    bestehend: instances.rs · launcher.rs · loader.rs · cosmetics.rs · mods/        │
└───────────────────────────────────┬───────────────────────────────────────────────┘
                                    │  JVM-Args + Mod-Pfade + Config-Pfade
                                    ▼
┌──────────────────────────── Minecraft (Fabric) ────────────────────────────────────┐
│  bamboo-client.jar                                                                 │
│    module/  ModuleRegistry · AbstractModule · ConfigField · SafetyTag              │
│    hud/     HudManager · HudPosition · HudAutoLayout · HudLook · FrameCache        │
│    gui/     MenuScreen · HudEditScreen · Widgets · Theme · StoreScreen (nur Link)  │
│    cosmetics/ wings · capes · wear · aura · pets · emotes · killfx · namestyle     │
│    map/     Minimap · WorldMap · MapStore · Waypoints                              │
│    perf/    Presets · Dynamic FPS · Particle/Culling-Anbindung                     │
│    mixin/   HUD, Titel, Pause, Chat, Nametag, Render, Input                        │
└───────────────────────────────────┬───────────────────────────────────────────────┘
                                    │  HTTPS (nur wenn online)
                                    ▼
                    Bamboo Backend: Katalog, Ownership, Dateien,
                    Presence (optional), Store, Telemetrie (opt-in)
```

**Warum Mod statt Injection:** Eine Mod ist ehrlich, überlebt Minecraft-Updates
kontrolliert, funktioniert mit Anti-Cheats und braucht keinen Prozess-Eingriff. Genau
dieser Weg steht schon in `docs/ROADMAP.md` (L1/L2) und ist dort richtig entschieden.

**Loader-Strategie:**

| Phase | Fabric | NeoForge | Forge |
| --- | --- | --- | --- |
| MVP | 1.21.1, 1.21.4, 26.2, 26.3 | nein | nein |
| Danach | weitere 1.21.x | 1.21.1, 26.x (gleicher Code, anderer Adapter) | nein |
| Nie | — | — | keine Neuentwicklung |

Die Mod wird pro Minecraft-Version kompiliert (Mappings ändern sich). Ein gemeinsamer
`common`-Teil (Katalog, Settings, Store-Client, HUD-Layout-Daten) und ein dünner
`fabric`-/`neoforge`-Teil halten den Aufwand klein.

---

## 5. Cosmetics im Detail

### 5.1 Typen und Mechanik (Bamboo-Version)

| Typ | Slots/Ausprägung | Technik | Einstellungen |
| --- | --- | --- | --- |
| **Wings** | Rücken, 3D | Mesh + Textur, Wingbeat-Animation (idle/run/glide), Glow | Scale, Offset Y, Glow, Farbe |
| **Cape** | Rücken | Animiertes GIF (Frames), Physik-Preset, optional Elytra-Textur | Physik, Länge, Farbe |
| **Aura** | um den Spieler | Prozedurale Partikel/Emitter, 20+ Muster | Farbe, Größe, Tempo, Dichte |
| **Wear** | head, ears, face, mask, neck, wrist, feet, back | Mesh + Textur + Maske, Knochenbindung, Spiegelung | Farbe, Offset, Tiefe |
| **Pet** | Begleiter | Sprite-Sheet, Zustände (follow/idle/sit/celebrate) | Größe, Farbe, Name |
| **Emote** | Spieleranimation | Animation + Props + Sound, Emote-Rad | Ton an/aus |
| **KillFX** | Kill-Ort | Partikel-Burst + Sound | Farbe, Lautstärke |
| **Name Style** | Chat/Tab/Nametag | Farbverlauf, Rainbow, Glitch, Typewriter, Wave | Tempo, Farben |

### 5.2 Katalog-Schema (Bamboo)

Wir übernehmen die bewährte Struktur, aber mit eigenem Namensraum und ohne Fremd-IDs:

```json
{
  "schema": "bamboo.cosmetics.v1",
  "featured": "bamboo_grove",
  "collections": [
    {
      "id": "bamboo_grove",
      "name": "Bamboo Grove",
      "tag": "SEASON 1",
      "description": "Ruhige Grüntöne, Laternenlicht und ein bisschen Panda."
    }
  ],
  "items": [
    {
      "id": "wings_crane",
      "type": "wings",
      "name": "Kranichflügel",
      "description": "Weiße Federn mit schwarzen Spitzen, ruhiger Flügelschlag.",
      "price": 2400,
      "collection": "bamboo_grove",
      "accent": "#8fd3a8",
      "style": "feathered",
      "scale": 0.85,
      "offsetY": 0.0625,
      "glow": false,
      "files": {
        "mesh": "<sha256>",
        "texture": "<sha256>",
        "preview": "<sha256>"
      },
      "inStore": true,
      "availableUntil": null,
      "status": null,
      "slot": null,
      "model": null
    }
  ]
}
```

Regeln:

- `id` ist stabil und eindeutig (`wings_…`, `cape_…`, `aura_…`, `wear_…`, `pet_…`,
  `emote_…`, `killfx_…`, `style_…`).
- `files` sind **nur Hashes**, nie URLs. Der Client holt sie über den Store-Endpoint.
- Max. 12 MB pro Datei, SHA-256 verpflichtend, atomar schreiben.
- `inStore: false` = vorhanden, aber nicht käuflich (Event/Quest/Owner).
- `availableUntil` = temporäre Items (Season), danach nicht mehr kaufbar, aber behalten.
- Unbekannte Typen werden ignoriert, nicht als Fehler behandelt.

### 5.3 Equip-State

```json
{
  "schema": "bamboo.client.loadout.v1",
  "active": "main",
  "loadouts": {
    "main": {
      "wings": { "id": "wings_crane", "color": "#ffffff" },
      "cape": { "id": "cape_paper_lantern", "physics": "soft" },
      "aura": { "id": "aura_fireflies", "color": "#b7ff7a", "size": 1.0, "speed": 0.8 },
      "wear": {
        "head": "wear_bamboo_crown",
        "ears": "wear_panda_ears",
        "back": "wear_bamboo_pack"
      },
      "pet": { "id": "pet_red_panda", "size": 1.0 },
      "killfx": "killfx_leaf_burst",
      "nameStyle": "style_bamboo"
    }
  }
}
```

Ablage: `<instanz>/bamboo/client/loadout.json` (pro Instanz) plus
`%APPDATA%\BambooLauncher\client\loadout-global.json` als Standard. Der Launcher
schreibt, die Mod liest im Tick und wendet Änderungen live an (max. 1× pro Sekunde).

### 5.4 Sichtbarkeit für andere

Cosmetics anderer Spieler müssen übertragen werden. Zwei Wege:

1. **Bamboo-Sync (eigener Kanal):** Der Client meldet beim Join eine kompakte
   Ausrüstung (IDs + Farben + Loadout-Hash) an das Bamboo-Backend; andere Clients
   holen sie über denselben Kanal. Das funktioniert auf jedem Server, weil es
   **out-of-band** über HTTPS läuft. Voraussetzung: beide nutzen Bamboo mit Account.
2. **Server-Relay (später):** Für lokale/testweise Sichtbarkeit ohne Backend kann ein
   eigener Server die Payloads weiterleiten. Nicht für öffentliche Server gedacht.

Wichtig und ehrlich: **Auf einem fremden Server ohne Bamboo sehen andere Spieler deine
Cosmetics nicht.** Das ist bei jedem Client so (Lunar, Badlion, Velo) und muss in der UI
klar stehen.

### 5.5 Erste eigene Kollektion (Startaufstellung)

Keine Velo-Dateien, keine Velo-Namen. Mechanisch dieselben Archetypen, eigenes Artwork:

| # | Item | Typ | Idee |
| --- | --- | --- | --- |
| 1 | Kranichflügel | Wings | weiße Federn, schwarze Spitzen |
| 2 | Bambusdrache | Wings | segmentierte grüne Schuppen, Glow |
| 3 | Papierdrache | Wings | leicht, kantig, rot/gold |
| 4 | Laternenflügel | Wings | warmes Licht, Glow |
| 5 | Bambusgrove-Cape | Cape | animierte Blätter + Lichtpunkte |
| 6 | Papierlaterne-Cape | Cape | schwingende Laterne, Glow |
| 7 | Tusch-Cape | Cape | schwarze Tusche, langsames Fließen |
| 8 | Glühwürmchen | Aura | langsam treibende Punkte |
| 9 | Bambusblätter | Aura | fallende Blätter im Wind |
| 10 | Laternenlicht | Aura | warme Lichter, die aufsteigen |
| 11 | Regenbogen nach Regen | Aura | feiner Bogen + Tropfen |
| 12 | Bambuskrone | Wear head | geflochtene Krone |
| 13 | Panda-Ohren | Wear ears | rund, schwarz/weiß |
| 14 | Bambusrucksack | Wear back | Sprossen + Riemen |
| 15 | Strohhut | Wear head | existiert schon als `.cosmiq` |
| 16 | Roter Panda | Pet | folgt, rollt, feiert Kills |
| 17 | Kranich | Pet | fliegt, landet auf der Schulter |
| 18 | Tee-Zeremonie | Emote | Tasse, Dampf, Sound |
| 19 | Panda-Rolle | Emote | Rolle vorwärts, Staub |
| 20 | Bambusbruch | KillFX | Splitter + grüne Partikel |
| 21 | Laubsturm | KillFX | Blätterwirbel |
| 22 | Bamboo-Grün | NameStyle | sanfter Verlauf |
| 23 | Goldlack | NameStyle | Gold mit Glanz |
| 24 | Sakura | NameStyle | rosa Blüten im Verlauf |

Die vorhandenen sechs Bamboo-Pakete (`bamboo-sticks`, `bird-cape`, `furry-ears`,
`furry-tail`, `strohhut`, `wagasa`) bleiben und werden in die Kollektion einsortiert.

### 5.6 Pipeline für neue Cosmetics

```
Blender / Blockbench
      │  Export: .glb/.obj/.bbmodel + PNG
      ▼
bamboo-cosmetic-cli convert   (Rust oder Java, headless)
      │  → .bmesh (Mesh + Bones + Material)
      │  → .btex  (PNG, optimiert)
      │  → preview.png (gerendert, 5:8)
      ▼
catalog.json + SHA-256 + Upload
      │
      ▼
Launcher zeigt Preview, Mod lädt über Hash
```

Für Wings reicht ein Mesh mit Bone `root` und optional `wing_l`/`wing_r` für die
Animation. Für Wear bindet `model.bone` an Vanilla-Knochen (`head`, `body`,
`right_leg`, `left_leg`, `right_arm`, `left_arm`), `model.mirror` für die Gegenseite.
Masken sind Graustufen-PNGs (weiß = sichtbar, schwarz = verdeckt) für Gesichter.

Der Launcher braucht nur **lesen** zu können: Preview + Metadaten. Gerendert wird im
Spiel; im Launcher zeigen wir das Preview-PNG und für Wings/Capes ein kleines
2,5D-Preview (wie Velo es macht).

---

## 6. In-Game-Menü und HUD

### 6.1 Menü

```
┌─────────────┬──────────────────────────────────────────────────────────┐
│  Bamboo     │  Module                              [ Suche… ]         │
│             │                                                          │
│ ▸ Modules   │  PERFORMANCE                             12              │
│   Locker    │  ┌────────────┐ ┌────────────┐ ┌────────────┐           │
│   Store     │  │ Performance│ │ Cosmetics  │ │ Dynamic FPS│           │
│   Map       │  │ Boost   ●  │ │ Quality ●  │ │         ○  │           │
│   Waypoints │  └────────────┘ └────────────┘ └────────────┘           │
│   Settings  │                                                          │
│             │  HUD                                    27              │
│  G schließt │  …                                                       │
└─────────────┴──────────────────────────────────────────────────────────┘
```

- Öffnen/Schließen: `G` (Default), änderbar; ESC schließt ebenfalls.
- Links Rail mit Icons + Labels, unten Settings/Profile.
- Suche filtert Name + Tags; Kategorien bleiben als Überschriften stehen.
- Modul-Karte: Icon, Name, Beschreibung (2 Zeilen), Toggle rechts.
  Klick auf die Karte öffnet die Config (Slider, Choice, Color, Keybind, Button).
- Alles im Bamboo-Theme: Akzent, Radius 9, Glas-Panel, Hairline, Hover-Slide.
- Animation beim Öffnen: 200 ms Fade + 260 ms Rise, Karten gestaffelt 35 ms.
- Der Screen pausiert das Spiel **nicht** (wie Velo), außer im Einzelspieler auf Wunsch.

### 6.2 HUD-Editor

- Öffnen aus dem Menü oder mit `RightShift` (Default).
- Drag = verschieben, Ecke = skalieren, × = ausblenden.
- Beim Ziehen: Mittellinien, Live-Label mit Prozent.
- Toolbar unten/mittig, weicht HUD-Tiles aus, Buttons: HUD Style · Reset · Done.
- „Snap to grid“ optional (8-px-Raster).
- Auto-Layout bleibt für nicht gesetzte Tiles aktiv; sobald ein Tile gezogen wurde,
  ist es „placed“ und wird nie mehr automatisch verschoben.
- Layouts werden pro Profil (global/server) gespeichert.

### 6.3 HUD-Style

| Feld | Werte | Default |
| --- | --- | --- |
| Font | Inter, Sora, Space Grotesk, Poppins, IBM Plex, JetBrains Mono, Audiowide, Minecraft | Inter |
| Hintergrund | None, Glass, Solid | None |
| Akzent | frei | Bamboo-Grün `#7ED9A0` |
| Shadow | an/aus | an |
| Rounded | an/aus | an |

### 6.4 Titel- und Pause-Menü

Der Client ersetzt das Vanilla-Titelmennü durch eine ruhigere Variante:

- Links: Logo + Version + MC-Version, darunter Reihen (Singleplayer, Multiplayer,
  Realms, Optionen, Quit) mit Hover-Slide und Akzentpfeil.
- Rechts: Karten für „Weiterspielen“, Store-Highlight, Freunde/Party, News.
- Pause: gleiche Sprache, links Navigation, rechts Weltinfo (Name, Spielzeit, Seed-Short),
  Quick Toggles (Favoriten/Recent), Party, unten „Alle Module ›“.
- Öffnen: 320 ms Cubic-Out, Hintergrund-Dim + Gradient, Inhalte gestaffelt.
- Kein Blur-Zwang (Performance), Blur optional.

### 6.5 Minimap und Weltkarte (Bamboo-Werte)

```text
Minimap:   128 px, Radius 96, Refresh 750 ms, Square, rotate on,
           Arrow 6 px, Koordinaten + Facing an, Border #2A2A2A, Arrow #7ED9A0
Weltkarte: 256er-Regionen, surface + cave-Bänder, 8 Chunks/Tick,
           600-Tick-Flush, Waypoints, LOD, Biom + Wasser-Schattierung
```

Die Karte wird **lokal** aus geladenen Chunks gebaut. Keine Server-Abfragen, kein
X-Ray (nur Oberflächen- und optional Höhlen-Layer, wie Velo).

### 6.6 Zoom

```text
Key: C · FOV 20 · In 110 ms · Out 130 ms · Scroll 12 %
Sensitivität skaliert · Maus-Glättung 50 % · Smooth Camera aus
```

---

## 7. Store

### 7.1 Aufbau

Tabs: **Featured · Wings · Capes · Auras · Emotes · Kill FX · Wear · Bundles · Collections**.

- **Featured:** Hero-Karte (3D-Preview, Name, Collection, Preis, „Ansehen“/„Kaufen“),
  darunter „Neu“, „Bundles“, „Auren“, „Emotes“, „Capes“ als Reihen mit „Alle ›“.
- **Karten:** Preview, Name, Collection-Tag, Preis in Coins, seltener Rahmen,
  Hover-Lift 2 px + Akzent-Hairline.
- **Detail:** große Preview, Beschreibung, „Equip“, „Kaufen“, „Im Bundle“,
  Farb-/Größen-Settings direkt testbar (Try-on).
- **Bundles:** 3–8 Items, Einzelpreis durchgestrichen, Bundle-Preis, „Enthalten“-Liste.
- **Collections:** alle Items einer Season, Story-Text, Fortschritt „x/y besessen“.

### 7.2 Wirtschaft (Bamboo bleibt kostenlos)

- **Bamboo-Coins** werden durch Spielzeit verdient: 10 Coins pro Minute, Cap pro Tag,
  Bonus für erste Instanz/erste Welt des Tages. Kein Kauf von Coins mit Echtgeld.
- Preise: 300–3.600 Coins (wie Velo), Bundles 20–35 % günstiger.
- Kein Item schaltet Gameplay frei. Alles ist kosmetisch.
- Optionales **Supporter-Paket** (einmalig, freiwillig): Badge + Dank, **keine**
  exklusiven Gameplay-Vorteile. Wenn du das nicht willst: ganz weglassen.
- Kein Abo, keine „Velo+“-Kopie, keine Paywall.

### 7.3 Kaufablauf

```
Karte → Detail → [Kaufen] → Bestätigung (Preis, Kontostand, neuer Stand)
      → Backend: Ownership prüfen, Coins abziehen (transaktional)
      → Client: Item freischalten, Dateien vorladen, Toast
```

- Ownership ist serverseitig; der Client darf nie selbst „besitzen“.
- Bei Offline-Start: gekaufte Items aus lokalem Cache, Kauf erst online.
- Restore: nach Neuinstallation holt der Client die Ownership-Liste und lädt Dateien
  über die Hashes nach.
- Käufe sind idempotent (Request-ID), damit ein Doppelklick nicht doppelt abbucht.

---

## 8. Performance-Layer

### 8.1 Pakete

| Paket | Mods | Wann |
| --- | --- | --- |
| **Basis** | sodium, lithium, ferrite-core, entityculling, immediatelyfast, modernfix, badoptimizations, krypton, particle-core, fast-ip-ping, cull-fewer-leaves, better-block-entities, fabric-language-kotlin, fzzy-config | immer (Client an) |
| **Windows** | windows-priority-boost | nur Windows |
| **Opt-in** | c2me, alternate-current, distanthorizons | Nutzer entscheidet im Client-Tab |
| **Legacy** | pylon, argentum, cera, sarcio, exploint | nur alte Versionen |
| **Nice** | gnetum, ixeris, wavey-capes | wenn kompatibel; ixeris nicht auf Win + 1.x |

### 8.2 Installationslogik (aus Velo gelernt)

1. Client-Version + MC-Version + Loader bestimmen.
2. Passende Modrinth-Version suchen (Game-Version + Loader), maximal 12 Kandidaten.
3. Required Dependencies prüfen; fehlt eine, überspringen (nicht den Start blockieren).
4. Mod-ID aus `fabric.mod.json` lesen; ist sie schon vorhanden, nichts tun.
5. Auf Clashes prüfen (`moreculling`, `vulkanmod`, `zirconium`).
6. In den Client-Cache laden (nicht in die Instanz), Hash prüfen.
7. Beim Start über `fabric.addMods` (oder Manifest) einbinden.
8. State schreiben: `{ enabled, gameVersion, installed: { slug: fileName }, optIn: {...} }`.
9. Bei Versionswechsel: alte Paket-Dateien entfernen, neu passend laden.
10. Jeder Fehler = Warnung im Log, Start ohne die Mod. Nie blockieren.

### 8.3 Presets

| Preset | Wirkung |
| --- | --- |
| Auto | passt Quality an FPS an (3 schlechte Sekunden → runter, 8 gute → rauf) |
| Default | Vanille-Grafik, nur Mods |
| Max FPS | Fast-Grafik, minimale Partikel, keine Schatten/Wolken, Entity-Distanz 50 % |
| Medium Quality | reduzierte Partikel, schnelle Wolken, Entity-Distanz 100 % |
| High Quality | Fancy, alle Partikel, Schatten an, Entity-Distanz 150 % |

Dazu einzeln: Max FPS, VSync (Off/On/Adaptive), Dynamic FPS, View-/Simulation-Distance,
Adaptive Render Distance, Turbo Entities, Turbo Block Entities, Partikel,
Entity Shadows, Clouds, Smooth Lighting, Fancy Leaves, Improved Transparency.

### 8.4 Nach-dem-Start-Frage

Die Frage „Behalten / Deaktivieren / Nicht mehr fragen“ ist Pflicht, weil der Nutzer
sonst nicht merkt, dass Mods im Spiel waren. Standard ist **Deaktivieren** (nichts
bleibt aktiv), Behalten ist eine bewusste Entscheidung. Dateien bleiben immer liegen.

---

## 9. Integration in Bamboo (Datei für Datei)

### 9.1 Frontend

| Datei | Änderung |
| --- | --- |
| `ui/src/components/Sidebar.tsx` | Client-Schalter über dem Settings-Button; Store/Locker/Client nur bei `clientMode`; `TabType` erweitern |
| `ui/src/App.tsx` | Routen `store`, `locker`, `client`; `useClientMode()`; Start-Hook für den Modus |
| `ui/src/hooks/useClientMode.ts` | **neu**: laden/speichern, `enabled`, `busy`, `toggle()` |
| `ui/src/components/client/StoreView.tsx` | **neu**: Tabs, Grid, Hero, Detail-Dialog, Bundles |
| `ui/src/components/client/LockerView.tsx` | **neu**: Wings/Capes/Auras/Wear/Pets/Emotes/KillFX, Equip, Loadouts |
| `ui/src/components/client/ClientView.tsx` | **neu**: Module, HUD-Layout, Performance, Presets, Opt-ins |
| `ui/src/components/client/HudPreview.tsx` | **neu**: 16:9-Bühne, Tiles drag/resize, Snap, Style |
| `ui/src/components/client/CosmeticPreview.tsx` | **neu**: Preview-PNG + Wings-Spin (CSS 3D) |
| `ui/src/components/settings/ClientTab.tsx` | **neu**: Client-Einstellungen (Startverhalten, Injection, Update-Kanal) |
| `ui/src/components/settings/settingsTabs.ts` | Tab `client` ergänzen (nur bei Client an) |
| `ui/src/lib/tauriBridge.ts` | neue Aufrufe + Typen |
| `ui/src/lib/motionTokens.ts` | Werte aus §2.1 ergänzen (falls nicht vorhanden) |
| `ui/src/lib/translations.ts` | alle neuen Texte de/en |

### 9.2 Rust

| Datei | Änderung |
| --- | --- |
| `src/client/mod.rs` | **neu**: Modulwurzel, `ClientState` |
| `src/client/state.rs` | **neu**: `client.json` lesen/schreiben, Migration |
| `src/client/mods.rs` | **neu**: Modrinth-Suche, Download, Cache, Hash, Clash-Regeln |
| `src/client/inject.rs` | **neu**: `fabric.addMods`-Args, Manifest-Fallback, Enable/Disable |
| `src/client/cosmetics.rs` | **neu**: Katalog-Cache, Datei-Download, Loadouts, Equip |
| `src/client/store.rs` | **neu**: Store-Client, Ownership, Coins, Kauf |
| `src/client/hud.rs` | **neu**: HUD-Layout lesen/schreiben, Defaults |
| `src/desktop/commands/client.rs` | **neu**: alle Tauri-Commands |
| `src/desktop/commands/mod.rs` | `pub mod client;` |
| `src/desktop/ipc.rs` | Launch-Payload um `client` erweitern; Args aus `inject.rs` anhängen |
| `src/instances.rs` | `client_paths(name)`; `bamboo/client/` anlegen; Manifest lesen |
| `src/cosmetics.rs` | bestehende `.cosmiq`-Pakete in den neuen Katalog einsortieren |

### 9.3 Commands (Vorschlag)

```rust
client_status() -> ClientStatus            // enabled, version, modCount, issues
client_set_enabled(enabled: bool) -> ClientStatus
client_sync(instance: String) -> SyncReport     // prüft/plant Injection
client_mods() -> Vec<ClientMod>                 // installiert, Version, Status
client_set_mod(id: String, enabled: bool)
client_optin(id: String, enabled: bool)
client_preset(name: String)
client_hud_get(instance: String) -> HudLayout
client_hud_set(instance: String, layout: HudLayout)
cosmetics_catalog() -> Catalog
cosmetics_equip(instance: String, loadout: Loadout)
cosmetics_files(ids: Vec<String>) -> Vec<PathBuf>
store_catalog() -> StoreCatalog
store_buy(itemId: String) -> PurchaseResult
store_ownership() -> Vec<String>
```

### 9.4 Datenablage

```
%APPDATA%\BambooLauncher\
  client\
    client.json            { enabled, version, lastSync, keepPolicy }
    modules.json           { id: { enabled, settings } }
    hud-global.json
    loadout-global.json
    mods\                  bamboo-client-<mc>.jar + Performance-Jars (Cache)
    store\                 catalog.json, ownership.json
  cosmetics-cache\
    catalog.json
    files\<sha256>
```

Pro Instanz:

```
<instanz>\
  bamboo\client\
    loadout.json
    hud.json
    managed.json          (nur Fallback-Injection)
    mods\                 (nur Fallback)
```

### 9.5 Schalter-Verhalten (Pseudocode)

```ts
async function toggleClient(next: boolean) {
  if (next) {
    await api.client.syncAll();        // Mods prüfen/laden, Status zeigen
    setClientMode(true);               // Store/Locker/Client einblenden
  } else {
    if (runningInstances.length > 0) {
      toast.warn(t.clientStopFirst);   // erst nach Spielende
      return;
    }
    await api.client.disableAll();     // nur unsere Dateien, nichts löschen
    setClientMode(false);
  }
}
```

Der Schalter ist nie „hart“: Beim Start einer Instanz entscheidet der gespeicherte
Zustand, ob injiziert wird. Ein laufendes Spiel wird nicht angefasst.

---

## 10. Backend

Minimal, aber ausreichend:

| Endpoint | Zweck |
| --- | --- |
| `GET /v1/cosmetics/catalog` | Katalog + Collections + featured |
| `GET /v1/cosmetics/file/<sha256>` | Datei, hash-geprüft |
| `GET /v1/store/catalog` | Store-Items, Bundles, Preise |
| `GET /v1/store/ownership` | gekaufte IDs (Account-gebunden) |
| `POST /v1/store/purchase` | Kauf, idempotent über Request-ID |
| `GET /v1/player/<uuid>/cosmetics` | Ausrüstung für andere Clients |
| `PUT /v1/player/<uuid>/cosmetics` | eigene Ausrüstung melden |
| `GET /v1/coins` / `POST /v1/coins/claim` | Kontostand, Spielzeit-Gutschrift |

Regeln:

- Ownership und Coin-Stand **nur** serverseitig; der Client schickt nie „ich besitze X“.
- Jeder Kauf mit Request-ID, transaktional, mit Audit-Log.
- Coins-Gutschrift mit Rate-Limit und Plausibilitätsprüfung (Spielzeit-Sessions).
- Cosmetics-Dateien sind öffentlich lesbar (Hashes), aber nur gegen gültigen Account
  als „besessen“ markiert. Das ist DRM-frei und ehrlich.
- Kein Zwang zu Presence: Wer offline ist, sieht eigene Cosmetics, andere sehen sie
  erst beim nächsten Sync.

Wenn Bamboo-Accounts noch nicht so weit sind: **Phase 1 komplett lokal** (eigene
Cosmetics, keine Coins, kein Kauf). Store zeigt dann „Bald verfügbar“ für Online-Items.
Das hält den Client sofort nutzbar.

---

## 11. Phasenplan

| Phase | Inhalt | Aufwand | Fertig, wenn |
| --- | --- | --- | --- |
| **P0 Fundament** | Client-Schalter, State, Mod-Cache, Injection (A/B), leere Client-Mod mit einem HUD-Tile, Start/Stop-Prompt | 1–2 Wochen | Instanz startet mit Tile, Schalter aus = Vanilla, nichts gelöscht |
| **P1 Menü + HUD** | In-Game-Menü, 12 HUD-Tiles, HUD-Editor, Style, Zoom, Minimap | 2–3 Wochen | Alle Tiles verschiebbar/skalierbar, Zoom und Minimap laufen |
| **P2 Cosmetics Basis** | Wings, Capes, Wear: Katalog, Download, Equip, Rendering, Launcher-Locker + Preview | 3–4 Wochen | Eigenes Cosmetic im Spiel sichtbar, andere Bamboo-Clients sehen es |
| **P3 Weltkarte** | Regionen, Recording, LOD, Waypoints, Vollbild-Screen | 2–3 Wochen | Karte füllt sich beim Laufen, Waypoints bleiben |
| **P4 Performance** | Mod-Paket, Presets, Opt-ins, Clash-Regeln, State | 1 Woche | Preset wirkt, Start ohne Mods möglich, Fehler blockieren nie |
| **P5 Store** | Store-UI, Coins, Ownership, Bundles, Kauf | 2–3 Wochen | Kauf bucht genau einmal, Restore funktioniert |
| **P6 Rest-Cosmetics** | Auras, Pets, Emotes, KillFX, Name Styles | 3–4 Wochen | Emote-Rad, Pet folgt, KillFX + Sound |
| **P7 Politur** | Titel/Pause, Animationen, Themes, i18n, Crash-Schutz, QA über Versionen | laufend | Keine Crashes, 60 fps in Lobby, alle Texte de/en |

**MVP = P0–P4** (ca. 10–14 Wochen). Alles danach ist Ausbau, kein Blocker.

---

## 12. Risiken und was wir bewusst nicht machen

| Risiko | Umgang |
| --- | --- |
| Velo-Assets | Nicht übernehmen. Eigene Modelle/Texturen/Sounds; MIT-Hinweis für Code |
| Anti-Cheat / Serverregeln | Nur erlaubte Features; Safety-Tags; keine Reach/Fly/AutoClicker; „prüfe Serverregeln“-Hinweis |
| Versionsmatrix | Pro MC-Version bauen; gemeinsamer Common-Teil; CI-Matrix |
| Performance | HUD-Frame-Cache, gedrosseltes Auto-Layout, Partikel-Budget, Cosmetics-LOD |
| Injection kaputt nach Fabric-Update | `fabric.addMods` + Manifest-Fallback + „Vanilla starten“-Knopf |
| Store ohne Backend | Phase 1 lokal, Online-Items später; Store zeigt klar „offline“ |
| Scope-Explosion | 129 Velo-Module sind **kein** Ziel. Bamboo startet mit ~25 Modulen und ~20 Tiles |
| Rechtliches an fremden Clients | Keine fremden Jars bündeln, keine Velo-Namen/Logos, keine Store-Art |

**Bewusst nicht übernommen:**

- Velo+-Abo und Echtgeld-Coins.
- World Hosting, Cloud-Sync, Freundes-Backend, Clip-Share (brauchen eigene Dienste).
- Velo-Redstone-Mode, Queue-/Ghost-Packet-Tools, Staff-/Owner-Screens.
- Gebündelte Vanilla-Jars (Bamboo lädt selbst).
- Auto-Vulkan/Threaded-Present-Extremumbau (zu versionsabhängig).
- Fremde Assets, Namen, Icons, Sounds.

---

## 13. Offene Entscheidungen

1. **Client-Mod-Basis:** Velo-Code (MIT) forken und auf Bamboo umschreiben, oder
   sauber neu bauen mit den hier dokumentierten Mechanismen? → Empfehlung: forken,
   aber Namespace, Assets und Backend sofort ersetzen.
2. **Erste Versionen:** nur 26.2/26.3 (wie Velo) oder auch 1.21.1/1.21.4?
   → Empfehlung: 26.2 + 1.21.4, dann 1.21.1.
3. **Injection:** `fabric.addMods` (verifiziert, seit Loader 0.12) oder immer Kopie
   mit Manifest? → Empfehlung: addMods mit `@`-Datei, Fallback Manifest.
4. **Store-Start:** rein lokal (keine Käufe) oder direkt Backend?
   → Empfehlung: lokal starten, Backend in P5.
5. **Coins:** Spielzeit-Coins oder alles frei schalten?
   → Empfehlung: Spielzeit-Coins, Preise wie Velo, kein Echtgeld.
6. **Supporter-Paket:** ja (nur Badge) oder nein?
   → Entscheidung des Owners; Standard: nein.
7. **Wear-Pipeline:** eigenes `.bmesh` oder Cosmiq-`.cosmiq` weiterverwenden?
   → Empfehlung: eigenes Format, Cosmiq-Import als Bonus.
8. **Name:** „Bamboo Client“ als Modus, Store-Tab „Bamboo Store“, Locker „Bamboo Locker“.

---

## 14. Anhang A — Wie die REA gemacht wurde

```text
1. Installation gesichtet: C:\Program Files\Velo Client Launcher
2. launcher.jar entpackt (356 MB), Klassen mit CFR 0.152 dekompiliert
   (Temurin JRE 21 als Decompiler-Laufzeit)
3. Mod-Jar aus der laufenden Instanz gezogen:
   %APPDATA%\VeloClient\instances\612727b9-…\mods\velo-client-26.2.jar
4. 2.780 Einträge inventarisiert, Packages/Module gezählt
5. Kataloge gelesen: cache/cosmetics/catalog.json (150 Items, 11 Collections),
   wings.json, collections.json, gnetum.json, version.properties
6. Konfigurationen gelesen: launcher-settings.json, theme.json, quick-toggles.json,
   menu-key.json, waypoints-v2.json, experimental-mods.properties
7. Schlüsselklassen dekompiliert: ModuleRegistry, ModuleCategory, AbstractModule,
   ConfigField, HudManager/Position/AutoLayout/Look, HudEditScreen, ModMenuScreen,
   PauseMenu, TitleMenu, StoreScreen, CosmeticsCatalog, CapeManager, Loadouts,
   ZoomModule, MinimapModule, WorldMap/MapStore/MapTextures/MapLod, Theme,
   PerformanceBoostModule, CosmeticsQualityModule, PerformanceModsInstaller,
   PlusAddons, UiMotion, LauncherSplash, ParticleBackground, WindowChrome
8. Meshes/Assets nur gesichtet (Header, Größen), nicht übernommen
9. Bamboo-Gegencheck: Sidebar/App/Settings, instances.rs, ipc.rs, launcher.rs,
   cosmetics.rs, ROADMAP.md
```

Wichtige Fundstellen (für später):

| Thema | Pfad in der REA |
| --- | --- |
| Modul-Kategorien | `module/ModuleCategory.java` |
| Config-Felder | `module/ConfigField.java` |
| HUD-Layout | `client/hud/HudPosition.java`, `HudAutoLayout.java` |
| HUD-Editor | `client/gui/HudEditScreen.java` |
| Menü-Rail | `client/gui/ModMenuScreen.java` |
| Pause-Animation | `client/gui/title/PauseMenu.java` (open 3.2E8 ns) |
| Zoom-Mathe | `client/modules/qol/ZoomModule.java` |
| Minimap | `client/modules/hud/MinimapModule.java` |
| Weltkarte | `client/levelmap/WorldMap.java`, `MapStore.java` |
| Kosmetik-Katalog | `client/cosmetics/CosmeticsCatalog.java` |
| Kosmetik-Equip | `client/cosmetics/Loadouts.java`, `WearManager.java` |
| Store | `client/gui/store/StoreScreen.java`, `StoreItems.java` |
| Performance-Mods | `launcher/launch/PerformanceModsInstaller.java` |
| Velo+ | `launcher/launch/PlusAddons.java`, `StoreScreen.PLUS_PERKS` |
| UI-Animationen | `launcher/ui/UiMotion.java`, `LauncherSplash.java` |

---

## 15. Anhang B — Gemessene Konstanten (übernehmen)

```
HUD: Margin 2 px · Gap 2 px · Update 50 ms · Scale 0,5–3,0 · Default 0,9
     Glass 0xA0… · Solid 0xF0… · Hairline 0x1CFFFFFF · Panel-Radius max 7
Menü: Öffnen 320 ms · Karten-Stagger 35 ms · Hover-Slide 2–3 px
Zoom: FOV 3–90 · 110/130 ms · 12 % Scroll · Glättung 0–500 ms
Minimap: 64–220 px · Radius 24–200 · Refresh 200–3000 ms
Weltkarte: 256er-Regionen · 8 Chunks/Tick · 600-Tick-Flush · 4×4-Biome
Store: Preise 300–3600 · 11 Collections · 7 Typen · 150 Items (Velo-Bestand)
Katalog: max 12 MB/Datei · SHA-256 · 30 s Refresh · 15 s Retry
Performance: 18 Basismods · 3 Opt-ins · 7 Legacy · State-Datei pro Instanz
Animationen: EASE_OUT (0.2,0.8,0.25,1) · Hover 140 ms · Press 70 ms
```

---

## 16. Anhang C — Velo-Modulliste (vollständig, nutzerseitig)

**Performance:** Performance Boost, Cosmetics Quality, Dynamic FPS, Entity Detail,
Entity View Cache, FOV, Frame Time Graph, Full Bright, GPU Utilization, HUD Cache Tuner,
Input Sampler, Memory Monitor, Particle Limiter, Render Culling, Seamless Reload,
Shader Cache, Sodium Visibility, Threaded Present, Decoupled Present, Video Options,
Auto Vulkan, Alternate Current, C2ME, Anti-Farm-Lag, Anti-Farm-Lag Compat, Poly Blur,
Deferred Sky, Pass Barriers, Vulkan Pipeline Cache.

**HUD:** Action Bar Log, Armor Bar, Armor Durability, Boss Bar, Clock, Coordinates, CPS,
FPS, Hearts, Held Item, Hotbar, HUD Style, Hunger, Keystrokes, Media Player, Minimap,
Mouse Buttons, Ping, Player Levels, Potion Timers, Scoreboard, Server Overlays,
Session Stats, Totem Counter, Waypoints, XP Bar.

**PvP:** Arrow Counter, Auto GG, Combo Counter, Cooldowns, Damage Numbers, Direction HUD,
Enemy Effects, Enemy Hunger, Fight Recap, Health Indicator, Height Limit, Hit Color,
Hit Particles, Hit Sounds, Item Position, Low Fire, Low Health Warning,
Old Animations, Pot Counter, Reach Display, Speed HUD, Target HUD, Totem Pops.

**QoL:** Anti-Coords-Leak, Attack Indicator, Centered Inventory, Chat Tweaks, Clips,
Custom Crosshair, Emoji Chat, Fly Speed, Free Look, Friends, Nick Hider, Own Name Tag,
Party Ping, Phantom, Shulker Preview, Small Caps, Toggle Sneak, Toggle Sprint,
Loading Screen, Zoom.

**Rendering:** Anti-Deepslate, Block Outline, Color Grading, Container Animations,
Container Slot View, Hide Foliage, Hold Up Items, No Break Particles, Particle Size,
Screen Stretch, Time/Weather Fog, TNT Timer, Velo Shaders.

**Server-Tools:** Chunk Border, Chunk Load Profiler, Client Log Viewer, Entity Count,
Game Mode Presets, Hitbox Visualizer, Light Level, Packet Traffic, Particle Debug,
Radius Shapes, Simulation Distance, Spawn Radius, TPS/Tick Graph, Visited Chunks,
World Border.

**Debug:** Better F3, Keybind Conflict Checker, Looking-At Inspector,
Module Profiler Overlay, Resource Reload Hotkey.

**Utility:** Auto Reconnect, Command Keybinds, Copy Coordinates, Session Auto Fixer,
Velo Network, Background Queue.

**Redstone:** Fast Grow, Hopper Speed, Tick Journal (+ Redstone Mode HUD).

**Cosmetics:** Cape, Wings, Aura, Kill Effects, Emotes.
