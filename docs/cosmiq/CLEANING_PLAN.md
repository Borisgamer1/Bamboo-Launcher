# Cosmiq 0.3.7.5 (MC 26.3, Fabric) – Analyse, Strip-Plan, Test-Setup

Stand: 3. November 2026
Quellen: `cosmiq-0.3.7.5-26.3-fabric.jar` (Downloads), neu dekompiliert mit Vineflower nach
`tools/decompiler/out/cosmiq` (Mod) und `tools/decompiler/out/common` (Core-Library `common-0.1.0.jar`).
Die alte JD-GUI-Ausgabe hatte 156 Klassen nur als `// INTERNAL ERROR //`; die sind damit jetzt vollständig lesbar
(u. a. `CosmiqDevMode`, `LocalEquippedCosmeticStore`, `CosmeticEditorScreen`, der Client-Entrypoint).

## Umsetzungsstand (3.11.2026)

Der Strip ist als eigenes Patch-Projekt umgesetzt: [cosmiq-patch](../cosmiq-patch/README.md).

| Phase | Status |
|---|---|
| 1 – Entrypoint strippen | **umgesetzt** (`CosmiqEditorFabric` ersetzt) |
| 2 – Buttons/Widgets | **umgesetzt** (kein `ScreenEvents`, kein `modmenu`-Entrypoint) |
| 3 – Screens stilllegen | **umgesetzt**: Screens bleiben im Jar, sind aber nicht erreichbar; `CosmiqWardrobeClient` ohne Titel-Hook/Gift/Friend-Activity; `CosmiqMfaScreen`/`CosmiqAgreementScreen.show*` sind No-Ops |
| 4 – Keybinds/Emotes | **umgesetzt** (keine KeyMappings, kein Emote-Wheel-Init, Emote-Mixins raus) |
| 5 – Shop/Gift | **umgesetzt** (Wardrobe-UI unerreichbar, Gift-Init entfernt) |
| 6 – Dev-Gate | **umgesetzt** (`CosmiqDevMode` liest `-Dbamboo.cosmetics` bzw. `cosmiq/launcher-mode.flag`) |
| 7 – Toasts | **offen** (Auth-/Server-Toasts weiterhin möglich) |
| 8 – Launcher-Kette | **umgesetzt** (`cosmiq-cli.jar`: convert/install/equip/unequip/list, State über Cosmiqs Store) |
| 9 – In-Game-Test | **teilweise bestanden**: Start auf Fabric 26.3/Java 25, Welt geladen, Titel- und Pause-Menü ohne Cosmiq-UI, lokale Cosmetics rendern; Multiplayer/Backend offen |

Ergebnis: `cosmiq-patch/dist/cosmiq-0.3.7.5-26.3-fabric-headless.jar` und
`cosmiq-patch/dist/cosmiq-cli.jar`.
Geprüft: Kompilierung, Jar-Integrität, Klassen-Ladetest, Launcher-Flag an/aus, keine UI-Referenzen
im Entrypoint, drei echte Bamboo-`.bbmodel`-Konvertierungen, Install/Equip/List/Unequip inklusive
State-Schema v3 und Mismatch-Recovery. Zusätzlich echter Clientstart mit Fabric API 0.165.0:
Titelbildschirm und Pause-Menü zeigen keine Cosmiq-Buttons, das Pause-Menü ist rein vanilla,
lokale Krone/Rücken-Cosmetics rendern. **Noch nicht geprüft:** Backend-Cosmetics anderer Spieler,
öffentliche Server, LAN-Relay und der Multiplayer-Screen. Der Test lief offline (Auth-401 erwartet).
Screenshots/Logs: `cosmiq-patch/test-instance/`.

---

## 0 · Verstanden

Ich habe deine Anforderungen so verstanden:

1. **Keine sichtbare UI** – keine Wardrobe-/Shop-/Social-Screens, keine Buttons im Titel-, Pause- oder Multiplayer-Menü,
   keine Keybinds, keine HUD-Elemente, keine Toasts, kein Mod-Menu-Config-Button.
2. **Auswahl nur über den Launcher** – der Launcher schreibt lokale Dateien; die Mod liest sie beim Start bzw. im Tick.
3. **Render- und Netzwerk-Pfad bleibt heil** – 3D-Cosmetics müssen weiter auf dem Spielermodell rendern, Cosmetics
   anderer Cosmiq-Nutzer sollen weiter über das Cosmiq-Backend ankommen.
4. **Eigene Blockbench-Modelle** – sie sollen als lokale Cosmetics erkannt, geladen und gerendert werden.
5. **BambooCosmetics-Renderer wird ersetzt** – die bestehende eigene Renderer-Mod (GeckoLib-`.geo.json`-Pfad) fällt weg.

### 0.1 Drei Randbedingungen, die den Plan bestimmen (bitte zuerst lesen)

**a) Lizenz.** Der Jar-Manifest sagt `LicenseRef-Cosmiq-All-Rights-Reserved`, `fabric.mod.json` ebenfalls.
Ein modifizierter Jar darf ohne schriftliche Erlaubnis von Cosmiq weder weitergegeben noch in einem Launcher
ausgeliefert werden. Der Plan unten ist technisch korrekt, aber **Distribution ist ein Lizenz-, kein Code-Problem**.
Sauberer Weg: schriftliche Freigabe von Cosmiq („fork für eigenen Launcher, keine Marketplace-Features“) oder
Renderer-Konzept nachbauen. Ich helfe beim technischen Fork, ersetze aber keine Rechtsberatung.

**b) Dev-Gate.** Lokale Cosmetics rendert die Mod **nur im Dev-Build und nur bei aktivem Dev-Mode**:
`assets/cosmiq/build-profile.properties` steht im ausgelieferten Jar auf `profile=prod`;
`CosmiqDevMode.enabled()` ist zusätzlich an `CosmiqBuildProfile.development()` und einen 10-Klick-Zähler auf das
Wardrobe-Logo gebunden. Das ist der zentrale Hebel für „unsichtbar, aber lokal sichtbar“ (Kapitel 2.7).

**c) Sync-Realität.** Das Cosmiq-Backend synchronisiert **nur Cosmetics, die es kennt und für die eine Ownership
existiert**. `LocalEquippedCosmeticRuntime.verifiedServerEquipment(...)` verwirft Equipment-Einträge ohne aktive
Ownership. Eigene, nur lokal vorhandene Pakete werden also **nicht** über das Cosmiq-Backend an andere Spieler
verteilt. Der einzige eingebaute Verteilweg für lokale Pakete ist der „Test Relay“ – und der braucht einen Server,
der die Custom-Payloads weiterleitet (Integrated/LAN-Server oder ein Fabric-Server mit aktiviertem Relay).
Auf einem fremden öffentlichen Server (Hypixel & Co.) sieht niemand deine lokalen Cosmetics außer dir.
Mehr dazu in Kapitel 1.8 und 3.5.

---

## 1 · Analyse

### 1.1 Aufbau des Jars

| Ebene | Inhalt |
|---|---|
| Äußerer Jar | Minecraft-Glue: Screens, Mixins, Runtime, Networking, Auth, Wardrobe-UI |
| `META-INF/jars/common-0.1.0.jar` | kompletter Core: `BbModelImporter`, `LegacyBbmodelConverter`, `LocalCosmeticCatalogue`, `LocalEquippedCosmeticStore`, `CosmeticMetadata`, Settings-Stores |
| `META-INF/jars/cosmetic-*.jar`, `asset-format`, `animation-*`, `core-api` | Definition, Compiler, Mesh-/Animations-APIs |
| `assets/cosmiq/...` | Texturen, Shader, Sounds, UI-Layouts, Test-Pakete (`test_content/*.cosmiq`) |

**Wichtig:** Cosmiq benutzt **kein GeckoLib**. Der Pfad ist
`Blockbench .bbmodel` → `BbModelImporter` → `CosmeticCompiler` → `CompiledCosmetic`/`MeshData` →
`NativeCosmeticRenderLayer` + `NativePreparedGeometryRenderer` + `NativeCosmeticTextureRegistry`.
Deine bisherigen `.geo.json`-Modelle werden von Cosmiq **nicht** gelesen. Der Importer erwartet `.bbmodel`
(mit eingebetteten oder referenzierten PNGs) bzw. fertige `.cosmiq`-Pakete.

Verifiziert: `BbModelImporter.importFile` ist der Einstieg; `LocalCosmeticCatalogue` scannt nur
`.bbmodel` und `.cosmiq`; `CosmeticSourceFormat` kennt genau diese beiden Formate.

### 1.2 Sichtbare UI – alle Einstiegspunkte

Es gibt **keine** Inventar-Injektion. Die Buttons kommen aus drei Stellen:

| # | Einstieg | Datei / Methode | Was erscheint |
|---|---|---|---|
| 1 | Fabric `ScreenEvents.AFTER_INIT` | `CosmiqEditorFabric.onInitializeClient`, Block mit `if (CosmiqEditorScreens.supportsSideButton(screen))` | Notification-Glocke, Wardrobe, Friends/Social, Website, Settings, dazu Dev-Buttons „UI Editor“, „Sign up“, „Update“ |
| 2 | `CosmiqTitleScreenStatus.initialize` | `Screens.getWidgets(screen).add(CosmiqEditorScreens.createWebsiteButton(...))` | zusätzlicher Website-Button auf dem Titelbildschirm |
| 3 | `JoinMultiplayerScreenMixin` | Injektion in `JoinMultiplayerScreen.init` | Reiter „Servers / Friends“ + Friend-Server-Liste |

Dazu kommen die **angehängten** UI-Schichten, ebenfalls alle im `ScreenEvents`-Block des Entrypoints registriert:

- `CosmiqSocialScreen` (rechte Social-Rail, Profile, Friend-Actions-Menü)
- `CosmiqNotificationScreen` (Benachrichtigungs-Drawer)
- `MinecraftAccountScreen` (Account-Panel)
- `CosmiqAgreementScreen` (ToS-Overlay)
- `CosmiqHoverText` (eigene Tooltips)
- `CosmiqFriendToastOverlay` + `CosmiqRealtimeNotifications` (Toasts)
- `CosmiqPlayerdoll` (HUD-Emote-Doll)

**Screen-Klassen (Lösch-/Stilllegungs-Kandidaten):**

`CosmeticEditorScreen`, `LocalCosmeticWardrobeScreen`, `WardrobeQuickMenuScreen` (inkl. Marketplace-Tab, Preisen,
Try-on, Outfits), `CosmiqSettingsScreen`, `CosmiqSocialScreen`, `CosmiqNotificationScreen`, `CosmiqChatScreen`,
`CosmiqGiftScreen`, `CosmiqFriendServersScreen`, `CosmiqFriendActionsMenu`, `CosmiqActivityPreviewScreen`,
`MinecraftAccountScreen`, `MinecraftAccountExpiredScreen`, `CosmiqMfaSetupScreen`, `CosmiqSecuritySettingsScreen`,
`CosmiqSecurityUnlockScreen`, `CosmiqUpdateScreen`, `CosmiqAgreementScreen`, `CosmiqDevBugReportScreen`,
`CosmiqDevelopmentAccessScreen`, `EmoteWheelScreen`, `EmoteWheelSetupScreen`, `EmoteAnimationSettingsScreen`,
`EmoteAnimationLogicScreen`, `EmotePreviewScreen`, `WardrobeSettingsPopup`, `AccessoryFitPopup`,
`BackAccessoryVisibilityPopup`, `LegacyCosmeticMetadataScreen`, `CosmiqWebAccessScreen`, `CosmiqMfaScreen`.

Zusätzlich: `CosmiqModMenuIntegration` hängt einen **Config-Button in Mod Menu** (Entrypoint `modmenu` in
`fabric.mod.json`). Muss raus.

**Dev-Sonderfall:** `CosmiqDevMode.openUiEditor(...)` startet `WardrobeLayoutDevServer` und öffnet ein
**Browser-UI** (`menusUrl()`), nach 10 Klicks auf das Wardrobe-Logo. Das ist kein In-Game-Menü, aber ein
UI-Einstiegspunkt – für dein Ziel komplett deaktivieren.

### 1.3 Mixins – was ist UI, was ist Renderer

**Behalten (Render-/Identitäts-/Audio-Pfad):**

| Mixin | Zweck |
|---|---|
| `AvatarRendererMixin` | Render-Layer, Hand-Render, Skalierung, RenderState |
| `PlayerModelMixin` | Modell-Pose/Anker für Cosmetics |
| `PlayerSkinMixin` | Skin-/Mannequin-Override |
| `HumanoidModelMixin`, `HumanoidArmorLayerMixin` | Armor-/Body-Interaktion (Occlusion) |
| `CapeLayerMixin`, `WingsLayerMixin` | Cape-/Elytra-Ersatz durch Cosmetics |
| `ModelPartMixin`, `ModelFeatureRendererMixin` | Mesh-/Feature-Rendering |
| `EntityRenderDispatcherMixin`, `LivingEntityRendererSelfNameTagMixin` | Render-Offsets / eigener Nametag |
| `LevelRendererCosmiqGlowMixin`, `GameRendererMixin` | Glow-Pipeline, Emote-Kamera, Wardrobe-Batch (Glow bleibt nötig) |
| `ParticleAccessor`, `ParticleEngineMixin`, `ParticleMixin`, `SingleQuadParticleAccessor` | Cosmetic-Partikel |
| `SoundEngineAccessor`, `SoundManagerAccessor` | Cosmetic-Sounds |
| `PlayerDisplayNameMixin`, `PlayerTabOverlayMixin`, `FontMixin` | Tags/Nameplates/Tab-Avatare – **optional**, gehört zum Social-Teil, nicht zu 3D-Cosmetics |
| `MinecraftAccountMixin`, `MinecraftAccountJoinMixin`, `MinecraftAccountConnectMixin`, `MinecraftDisconnectMixin` | Multi-Account-Support (für deinen Launcher evtl. nützlich) |
| `compat/ClothCapeLayerMixin`, `WaveyCapeLayerMixin`, `Emf*`, `Etf*`, `FemaleGender*`, `TravelersBackpack*`, `JegnGunFirstPersonArmMixin` | Cosmetics auf Modded-Playern korrekt rendern |

**Entfernen (UI-only):**

| Mixin | Grund |
|---|---|
| `JoinMultiplayerScreenMixin` | Friends-Reiter im Multiplayer-Menü |
| `GuiSettingsOverlayMixin` | Settings-Overlay-Transition/Toasts |
| `GuiRendererMenuCaptureMixin`, `GuiStateMenuCaptureMixin`, `ScreenMenuCaptureMixin` | Screenshot-Capture für den UI-Editor |
| `TitleScreenMenuReferenceMixin` | Referenz-Capture Titelmenü (UI-Editor) |
| `AbstractWidgetCornersMixin`, `AbstractWidgetSoundsMixin` | Cosmiq-Button-Styling/Sounds global |
| `EmoteWheelBlurMixin` | Blur hinter Emote-Rad |
| `ScreenSettingsBlurMixin` | Blur hinter Settings-Overlay |
| `TitleScreenPlayerDisplayMixin` | Player-Doll auf Titel/Pause |
| `PictureInPictureRendererMixin`, `PictureInPictureRendererAccessor` | Portrait-Rendering für UI |
| `WorldOpenFlowsMixin` | Update-Defer + „Loading Wardrobe…“ |
| `LevelLoadingScreenMixin` | Wardrobe-Temp-World-Ladescreen |
| `ConnectScreenUpdateMixin` | Update-Prüfung im Connect-Screen |
| `MinecraftServerSaveMixin`, `PlayerListSaveMixin`, `PersistentEntitySectionManagerSaveMixin`, `SavedDataStorageSaveMixin`, `ServerChunkCacheSaveMixin` | Schutz der Wardrobe-Temp-World vor Speichern – nur nötig, solange `WardrobeTemporaryWorld` existiert |
| `KeyboardHandlerMixin`, `MouseHandlerMixin`, `KeyboardInputMixin`, `LocalPlayerSprintMixin` | Emote-Kamera/-Steuerung (nur entfernen, wenn Emotes komplett raus) |
| `HudAccessor` | Actionbar-Text für Emotes |
| `compat/Flashback*`, `compat/Essential*` | Replay-Popups bzw. Essential-Titelbildschirm |

### 1.4 Keybindings

Registriert werden **7 KeyMappings** in `CosmiqEditorFabric.onInitializeClient`:

| Key | Tasten-Code | Default |
|---|---|---|
| `key.cosmiq.emote_wheel` | 21 | belegt (welche Taste das im Controls-Screen anzeigt, beim ersten Start prüfen) |
| `key.cosmiq.emote_zoom_in` | – | unbound |
| `key.cosmiq.emote_zoom_out` | – | unbound |
| `key.cosmiq.emote_action_1` … `_4` | – | unbound |

Sie landen in der Kategorie `cosmiq:emotes` in den Vanilla-Controls. `EmoteWheelController.initialize(...)` verbindet
sie mit dem Emote-Rad (`EmoteWheelScreen`). Für „keine Keybinds“: den kompletten KeyMapping-Block und
`EmoteWheelController.initialize` entfernen. Die Lang-Keys (`key.cosmiq.*`) können bleiben, sie sind dann unsichtbar.

### 1.5 Kauf-/Marketplace-Features

| Feature | Ort |
|---|---|
| Kauf einzeln | `CosmiqWardrobeHttpClient.purchase(id)` → `POST api/cosmetics/{id}/purchase` |
| Kauf Paket | `purchaseMorphPackage(id)` → `api/client/morph-packages/{id}/purchase` |
| Batch-Kauf | `purchaseMany(ids)` → `api/client/purchases` |
| Preiswährung | `priceStars` (Stars) im Wardrobe-Protokoll |
| Marketplace-Tab | `WardrobeQuickMenuScreen.WardrobeTab.MARKETPLACE`, `CatalogueEditorElement.MARKETPLACE`, `PriceOrder` |
| Gifting | `CosmiqGiftScreen`, `CosmiqGiftRuntime`, `CosmiqGiftClient`, `WardrobeGiftHighlight`, `CosmiqGiftToast` |
| Promo-Codes | `CosmiqWardrobeApiProtocol.PromoCodePreview` |
| Test-Kauf-Command | `CosmiqWardrobeTestFunctions` (`/cosmiq purchase …`, nur mit `COSMIQ_ENABLE_TEST_FUNCTIONS`) |

Alles davon hängt an der Wardrobe-UI. Wenn `WardrobeQuickMenuScreen` und die Gift-Klassen weg sind, ist der
Kaufpfad toter Code. Die HTTP-Methoden selbst können bleiben (sie werden nie aufgerufen) oder mit gelöscht werden.
**Ownership-Checks (`ServerVerifiedCosmeticRuntime`) nicht anfassen** – sonst brichst du den legitimen Backend-Pfad.

### 1.6 Render-Pipeline – „nicht anfassen“-Liste

Diese Klassen tragen das eigentliche Rendering und bleiben unverändert:

```
NativeCosmeticRenderLayer          NativePreparedGeometryRenderer
NativeCosmeticTextureRegistry      NativeCosmeticPreviewRegistry
NativeCosmeticRenderData           PrecisePlayerMesh / PrecisePlayerRenderLayer
PreciseEquipmentMesh               PreciseMeshSubdivision
CapeAnimationTextureManager        CosmeticEffectRuntime (+ Partikel/Sounds)
CosmeticPreviewPlanner             CosmeticLayeringPolicy
LocalCosmeticAnimationClock        VanillaPlayerPoseSampler / CosmiqPlayerPose
PlayerAppearanceRuntime            PlayerCapeTextureRuntime / PlayerCapeVisibilityRuntime
RemotePlayerCosmeticRuntime        ServerVerifiedCosmeticRuntime
LocalEquippedCosmeticRuntime       (bis auf das Dev-Gate, siehe 2.7)
```

Der Einstieg ins Rendering läuft über `NativeCosmeticRenderLayer` (gerufen aus den Render-Mixins),
`PlayerAppearanceRuntime.appearance(...)`, `PlayerCapeTextureRuntime.findCape(...)`,
`PlayerCapeVisibilityRuntime` → `LocalEquippedCosmeticRuntime.find/findCape/hidesVanillaCape`.

### 1.7 Lokale Cosmetics – so funktioniert der eingebaute Pfad

**Verzeichnisse** (`LocalDevContentDirectories.ensure(gameDir)`):

```
<gameDir>/cosmiq/
  dev/
    cosmetics/     <- .bbmodel und .cosmiq; nur .cosmiq ist equipbar
    capes/         <- nur .cosmiq; wird als Typ "cape" behandelt
    emotes/        <- Emote-Pakete
    imports/       <- Staging-Verzeichnis für den In-Game-Import
    cache/         <- Mod-Cache
    equipped-cosmetic.json
```

**Scan-Regeln** (`LocalCosmeticCatalogue`):

- maximal 512 direkte Einträge pro Verzeichnis, keine Symlinks, keine Unterordner
- `.bbmodel` wird im Katalog angezeigt, kann aber **nicht** equipped werden:
  `LocalEquippedCosmeticStore.equip` wirft „Only .cosmiq packages can be equipped; convert this Blockbench project first“
- `capes/` akzeptiert nur `.cosmiq` (`packagesOnly = true`)
- Der Typ ergibt sich aus dem Ordner: `capes/` → `"cape"`; sonst `bodySlots` enthält `cosmiq:slot/back` → `"back"`,
  sonst `"accessory"`

**State-Datei** (`LocalEquippedCosmeticStore`, Klasse vollständig in
`tools/decompiler/out/common/dev/cosmiq/editor/core/LocalEquippedCosmeticStore.java`):

- Datei: `<gameDir>/cosmiq/dev/equipped-cosmetic.json`
- Schema: `cosmiq.local-equipped.v3`
- Felder pro Selection: `fileName`, `projectId`, `sourceRevision`, `textureVariantId`
- maximal 6 Selections, eindeutige `fileName` und `projectId`
- `projectId` und `sourceRevision` **müssen** exakt zum Manifest des Pakets passen, sonst greift
  `Recovery.STALE_PACKAGE` und der Eintrag wird verworfen (und die Datei neu geschrieben)
- Ist die Datei kaputt → `Recovery.INVALID_STATE`, Datei wird gelöscht, nichts wird gerendert

Beispiel: [equipped-cosmetic.example.json](docs/cosmiq/equipped-cosmetic.example.json).

**Dev-Gate** in `LocalEquippedCosmeticRuntime` (Vineflower-Zeilen): 106, 120, 197, 307, 360, 377, 461, 465,
975, 1008, 1091, 1112, 1240, 1287, 1319, 1345 – überall `CosmiqDevMode.enabled()`. Zusätzlich blockiert
`CosmiqDevMode.available()` über `CosmiqBuildProfile.development()` (Property `profile=dev`).

**Warum die Mod trotzdem lokal lädt:** `renderData(...)` ruft bei `!started` selbst `requestReload()` auf, sobald
das Dev-Gate offen ist. Ein explizites `ensureLoaded()` ist nicht nötig, kann aber im Entrypoint ergänzt werden.

### 1.8 Sync – was geht und was nicht

**Backend-Pfad (offiziell):** `CosmiqWardrobeRuntime.refresh()` holt den Wardrobe-Snapshot (Equipment aller Spieler)
und ruft `LocalEquippedCosmeticRuntime.replaceServerEquipment(...)`. `verifiedServerEquipment(...)` prüft jede
Selection gegen `ServerVerifiedCosmeticRuntime` (Ownership). Nicht besessene Cosmetics werden verworfen.
Der Realtime-Client (`CosmiqRealtimeClient`) liefert Equipment-Updates und Paket-Indizes; die Pakete selbst werden
verschlüsselt geladen (`CosmiqPackageCipher`, `CosmiqTextureCacheCipher`). Das funktioniert auf jedem Server, weil
es out-of-band über `cosmiq.gg` läuft – aber nur für Cosmiq-Cosmetics.

**Lokaler Pfad (Test Relay):** `CosmiqTestRelayClient` schickt die sechs lokalen Pakete als
`cosmiq:test_relay_upload_v1` (max. 8 MB) an den Server; `CosmiqTestRelayServer` verteilt sie als
`test_relay_snapshot_v1` an andere Clients. Voraussetzungen:

- Dev-Build (`CosmiqBuildProfile.development()`) **und** `CosmiqDevMode.enabled()`
- Relay auf dem Server aktiviert: `-Dcosmiq.testRelay=true` oder `COSMIQ_TEST_RELAY=true`
- Der Server muss die Custom-Payloads weiterleiten (Integrated Server/LAN oder Fabric-Server mit der Mod)

Auf einem fremden öffentlichen Server ist beides nicht gegeben. **Fazit:** „auf jedem öffentlichen Server sichtbar
für andere“ ist mit lokalen Assets nicht erreichbar. Optionen: eigenes Out-of-band-Sync (BambooBackend per
WebSocket/HTTP, alle Spieler brauchen deinen Build), Relay auf eigenem Server, oder Cosmiq-Cosmetics regulär
über das Backend.

---

## 2 · Cleaning-Plan

### 2.1 Strategie: Binär-Patch statt Komplett-Rebuild

1.145 Klassen aus Decompiler-Ausgabe neu zu bauen ist ein Wochenprojekt (JD/Vineflower-Artefakte, Records,
Synthetic-Code, fehlende Debug-Infos). Für v1 empfehle ich **gezieltes Klassen-Patching**:

- Original-Jar behalten (Assets, alle unveränderten Klassen, Nested Jars)
- nur die wenigen neu geschriebenen Klassen kompilieren und per `zip -u` in eine Kopie des Jars ersetzen
- `cosmiq.mixins.json` und `fabric.mod.json` anpassen
- **UI-Klassen im Jar lassen, nur die Einstiegspunkte entfernen.** Grund: Der Jar ist kein Modularbaukasten.
  Entfernte Klassen, die von behaltenen Klassen referenziert werden, führen beim Laden zu
  `NoClassDefFoundError` – auch wenn der Codepfad nie ausgeführt wird. Konkrete Beispiele:
  `CosmiqRealtimeClient.screenOpened(...)` referenziert `WardrobeQuickMenuScreen` und
  `LocalCosmeticWardrobeScreen`; `GameRendererMixin` referenziert `MenuUiScreenshot`, `MenuUiRuntime` und
  `WardrobePreviewBatchRenderers`; `LocalEquippedCosmeticRuntime.find(...)` referenziert
  `WardrobeTemporaryWorld`. Wer löschen will, muss alle Referenzen mit patchen – das ist v2.

**Gradle-Setup für die Patch-Klassen:**

```gradle
plugins { id 'fabric-loom' version '1.17.21' }
java { toolchain { languageVersion = JavaLanguageVersion.of(25) } }
dependencies {
    minecraft "com.mojang:minecraft:26.3"
    mappings loom.officialMojangMappings()        // Jar ist "Fabric-Mapping-Namespace: official"
    modImplementation "net.fabricmc:fabric-loader:0.19.5"
    modImplementation "net.fabricmc.fabric-api:fabric-api:..."   // passende 26.3-Version
    compileOnly files("libs/cosmiq-0.3.7.5-26.3-fabric.jar")
}
```

Der Jar ist auf **offizielle Mojang-Namen** remappt (kein Refmap, kein Access-Widener). Deshalb
`officialMojangMappings()` und keine Yarn-Namen in neuem Code verwenden.

**Warum nicht „nur ein Companion-Mixin-Mod“?** Damit lassen sich viele UI-Einstiege abschalten
(`CosmiqEditorScreens.supportsSideButton` überschreiben, `CosmiqDevMode` überschreiben), aber der
`JoinMultiplayerScreenMixin` der Mod lässt sich so nicht entfernen – nur die hinzugefügten Buttons verstecken.
Für einen Prototyp okay, für ein Produkt unsauber.

### 2.2 Phase 1 – Entrypoint strippen

Datei: `tools/decompiler/out/cosmiq/dev/cosmiq/editor/fabric/CosmiqEditorFabric.java`

**Entfernen:**

- `initializeSafely("title-screen status", ...)` → `CosmiqTitleScreenStatus.initialize`
- `CosmiqWebAccessScreen.installSettingsEntry()`
- `initializeSafely("bug reports", ...)`, `initializeSafely("local notification tester", ...)`
- `initializeSafely("test relay", CosmiqTestRelayClient::initialize)` (nur behalten, wenn du LAN-Relay testen willst)
- `HudElementRegistry.addLast("emote_playerdoll", ...)`
- `HudElementRegistry.addLast("friend_activity_toasts", ...)`
- `LocalBackgroundSceneRuntime` / `WardrobeUiLayoutRuntime` / `SettingsUiLayoutRuntime` / `MenuUiRuntime` /
  `PlayerTagLayoutRuntime` / `WardrobeDevStateRuntime` – alle Layout-/UI-Runtimes
- **`LocalClientSettingsRuntime.initialize(...)` NICHT entfernen.** `LocalEquippedCosmeticRuntime` liest daraus
  `animationFadeMillis()`, `animationStateDelayMillis()`, `fallDelayMillis()` und `preferenceEnabled("misc.cosmetic_states")`.
  Ohne Init fallen Animations-/State-Einstellungen auf undefinierte Defaults zurück.
- `CosmiqWardrobeClient::initialize` **behalten** (Backend-Sync), `CosmiqWardrobeTestFunctions` **entfernen**
- `CosmiqDevMode.endSession()`-Hook kann bleiben (suspendiert beim Beenden nur den lokalen Runtime-State)
- `ResourceLoader`-Theme-Listener nur behalten, wenn du die Theme-Assets weiter nutzt; für reines Rendering unnötig
- **KeyMapping-Block + `EmoteWheelController.initialize(...)`** komplett
- Tick-Hooks: `CosmiqButtonBadgeClient`, `CosmiqUpdateManager`, `EmoteWheelController`, `WardrobeTemporaryWorld`,
  `WardrobeUiLayoutRuntime`, `SettingsUiLayoutRuntime`, `PlayerTagLayoutRuntime`, `WardrobeDevStateRuntime`,
  `CosmiqMultiClientAutoConnect`, `CosmiqMultiClientProbe`, `CosmiqTestRelayClient`, `Flashback*`,
  `CosmiqEffectMeasurementRecorder` (optional behalten)
- **Beide `ScreenEvents.AFTER_INIT`-Registrierungen** (Buttons, Social-Rail, Notification-Drawer, Account-Panel,
  Agreement-Overlay, Screen-Tick/Remove-Handler; die zweite macht nur die Hover-Texte)
- `ClientPlayConnectionEvents.JOIN`: `CosmiqTestRelayClient.onJoin`, Emote-Clears, MultiClient-Hooks raus;
  `CosmiqWardrobeRuntime.refresh()` und `CosmiqRealtimeClient.joinServer(client)` **drin lassen**
- `ClientPlayConnectionEvents.DISCONNECT`: Emote-/Relay-Clears raus; Realtime-/Auth-Cleanup drin lassen
- `initializeDevelopmentTools()`-Aufruf raus (sonst versucht die Mod `CosmiqDevTools` zu laden)

**Drin lassen:**

- `CosmiqClientAuthentication::initialize` + `onEndClientTick` + Join/Disconnect-Hooks (stiller Login)
- `CosmiqWardrobeClient::initialize`, `CosmiqRealtimeClient::initialize`, `CosmiqWardrobeRuntime.refresh()`
- `LocalEquippedCosmeticRuntime.onEndClientTick` (lokales Laden/Rendern)
- `CapeAnimationTextureManager`, `CosmeticEffectRuntime`
- `CosmiqDiscordPresenceClient` (optional; ist kein GUI)
- `CosmiqVersionElection.claim` (verhindert Doppel-Init)
- `CosmiqFeatureIsolation.run(...)` (Fehlertoleranz)

Ergänzen: `ClientLifecycleEvents.CLIENT_STARTED` → `LocalEquippedCosmeticRuntime.ensureLoaded()` (eine Zeile),
damit die lokalen Pakete schon vor dem ersten Render stehen.

### 2.3 Phase 2 – Buttons & Widgets

- `CosmiqEditorFabric`: `ScreenEvents`-Block löschen (siehe 2.2). Damit sind Titel-/Pause-Buttons weg.
- `CosmiqTitleScreenStatus.initialize` nicht mehr aufrufen (zweiter Website-Button).
- `JoinMultiplayerScreenMixin` aus `cosmiq.mixins.json` entfernen.
- `fabric.mod.json`: `entrypoints.modmenu` entfernen; optional `CosmiqModMenuIntegration` löschen.
- `CosmiqEditorScreens` bleibt als Klasse im Jar (wird nicht mehr aufgerufen). Löschen erst, wenn
  `CosmiqTitleScreenStatus` und alle anderen Referenzen mit angepasst sind.

### 2.4 Phase 3 – Screens stilllegen (v1: **nicht** löschen)

**Empfehlung für v1:** Klassen im Jar lassen und nur dafür sorgen, dass sie nie geöffnet werden. Das ist
robuster als Löschen, weil der Jar zahlreiche Querreferenzen hat (siehe 2.1). Löschen ist erst sinnvoll, wenn
du die referenzierenden Klassen ohnehin neu kompilierst.

Falls du später löschst, sind das die Kandidaten (alle in 1.2 genannten Screen-Klassen plus ihre Helfer):

```
CosmiqGiftScreen, CosmiqGiftRuntime, CosmiqGiftClient, CosmiqGiftToast, WardrobeGiftHighlight,
WardrobeQuickMenuScreen (+ sämtliche $Inner), LocalCosmeticWardrobeScreen, CosmeticEditorScreen,
CosmiqSocialScreen, CosmiqSocialRuntime, CosmiqSocialAssetRuntime, CosmiqChatScreen, CosmiqChatHistory,
CosmiqNotificationScreen, CosmiqFriendToastOverlay, CosmiqFriendActionsMenu, CosmiqFriendServersScreen,
CosmiqActivityPreviewScreen, CosmiqSettingsScreen, CosmiqSettingsButtonSkin, SettingsOverlayLifecycle,
MinecraftAccountScreen, MinecraftAccountExpiredScreen, CosmiqMfaScreen, CosmiqMfaSetupScreen,
CosmiqSecuritySettingsScreen, CosmiqSecurityUnlockScreen, CosmiqUpdateScreen, CosmiqUpdateToast,
CosmiqUpdateManager, CosmiqUpdateWindow, CosmiqAgreementScreen, CosmiqDevBugReportScreen,
CosmiqDevBugReportForm, CosmiqDevBugReportUi, CosmiqDevelopmentAccessScreen, CosmiqWebAccessScreen,
EmoteWheelScreen, EmoteWheelSetupScreen, EmoteAnimationSettingsScreen, EmoteAnimationLogicScreen,
EmotePreviewScreen, WardrobeSettingsPopup, AccessoryFitPopup, BackAccessoryVisibilityPopup,
LegacyCosmeticMetadataScreen, CosmiqMenuButton, CosmiqMenuTextures, MenuUiRuntime, MenuUiArtwork,
MenuUiScreenshot, MenuUiViewport, CosmiqTitleScreenStatus, WardrobeTemporaryWorld,
WardrobeLayoutDevServer, WardrobePreviewBatchRenderers (nur Wardrobe-UI), CosmiqDrawerScroll/Transition
```

**Vor jedem Löschen:** `grep -R "<Klassenname>" tools/decompiler/out` über den gesamten Baum. String-Referenzen
(z. B. `CosmiqTelemetryClient` matcht `"WardrobeQuickMenuScreen"`) sind harmlos, Klassen-Referenzen nicht.

### 2.5 Phase 4 – Keybinds & Emotes

- KeyMapping-Block aus `CosmiqEditorFabric` entfernen (7 Registrierungen).
- `EmoteWheelController.initialize(...)` und alle Tick-Hooks entfernen.
- `KeyboardHandlerMixin`, `MouseHandlerMixin`, `KeyboardInputMixin`, `LocalPlayerSprintMixin`, `HudAccessor`
  aus der Mixin-Config nehmen (nur wenn du Emotes nicht behalten willst; Emotes sind ein eigenes Feature,
  kein Kleiderschrank).
- `StationaryEmoteControls`, `EmoteOrbitCameraController`, `LocalPlayerEmoteRuntime`,
  `RecordedPlayerEmoteRuntime`, `ServerVerifiedEmoteRuntime`, `LocalEmoteWheelRuntime`,
  `CosmiqRealtimeEmote*`, `FlashbackEmote*` können bleiben (toter Code) oder mit raus.

### 2.6 Phase 5 – Shop/Gift

- `WardrobeQuickMenuScreen` ist der einzige Ort, der `CosmiqWardrobeRuntime.purchase*` aufruft. Ohne Wardrobe-UI
  ist der gesamte Kaufpfad nicht mehr erreichbar.
- Gift-Klassen (siehe 2.4) werden nicht mehr geöffnet; im Jar lassen (v1) oder später mit löschen (v2).
- Optional: `purchase`, `purchaseMany`, `purchaseMorphPackage` aus `CosmiqWardrobeRuntime`/`CosmiqWardrobeHttpClient`
  entfernen, damit kein toter Netzwerkpfad bleibt.
- `CosmiqWardrobeApiProtocol.PromoCodePreview` kann bleiben (wird nur vom Wardrobe-UI benutzt).

### 2.7 Phase 6 – Dev-Gate durch Launcher-Gate ersetzen

Ziel: lokale Cosmetics rendern, ohne dass der 10-Klick-Dev-Mode und der Browser-UI-Editor aktiv werden.

**Minimaler Patch (empfohlen): nur `CosmiqDevMode` neu schreiben.**

```java
public final class CosmiqDevMode {
    private static final boolean LAUNCHER_MODE = resolveLauncherMode();

    private static boolean resolveLauncherMode() {
        if (Boolean.getBoolean("bamboo.cosmetics")) return true;
        Path gameDir = FabricLoader.getInstance().getGameDir();
        return Files.isRegularFile(gameDir.resolve("cosmiq/launcher-mode.flag"));
    }

    public static boolean available() { return LAUNCHER_MODE; }
    public static synchronized boolean enabled() { return LAUNCHER_MODE; }
    public static synchronized String openUiEditor(Minecraft mc) { return "disabled"; }
    public static synchronized String clickWardrobeLogo(Minecraft mc) { return ""; }
    public static synchronized String clickSettingsLogo(Minecraft mc) { return ""; }
    public static synchronized void endSession() { /* nothing */ }
}
```

Warum das reicht: `LocalEquippedCosmeticRuntime` prüft ausschließlich `CosmiqDevMode.enabled()`; alle anderen
Dev-Mode-Konsumenten (Editor, lokale Wardrobe, Menu-UI, Dev-State) sind nach Phase 2–5 nicht mehr erreichbar
oder nicht mehr initialisiert. `available()` wird nur noch von UI-Fabriken benutzt, die nicht mehr aufgerufen werden.

**Wichtig:** `CosmiqBuildProfile.development()` bleibt auf `prod`. Damit gilt weiterhin:

- offizielles Backend (`https://cosmiq.gg/`), kein `COSMIQ_CORE_URL`-Override
- App-Data unter `%APPDATA%/gg.cosmiq.mod`
- kein Dev-Agreement-Screen, keine Dev-Tools, kein Dev-Fixture-Install

**Launcher-Flag:** System-Property beim Java-Start setzen, z. B. `-Dbamboo.cosmetics=true`, oder die Flag-Datei
`<gameDir>/cosmiq/launcher-mode.flag` anlegen. Die Flag-Datei ist launcher-freundlicher (kein JVM-Arg in den
Instanz-Settings nötig), die Property ist expliziter. Beides gleichzeitig ist robust.

**Nicht** `profile=dev` setzen: dann kippen App-Data-Pfad, Backend-Origin, Dev-Agreement und Dev-Tools mit.

### 2.8 Phase 7 – „unsichtbar“ für Toasts/Notifications

`CosmiqRealtimeClient.onEndClientTick` ruft intern `CosmiqRealtimeNotifications` auf (Auth-Expired, Connecting,
Server-Activity, Friend-Joins). Es gibt keine Setting, die das komplett abschaltet. Optionen:

1. **Sauber:** `CosmiqRealtimeNotifications` auf No-Op patchen (nur die öffentlichen `show*`/`hide*`-Methoden;
   die Klasse ist ~37 KB, aber die API-Fläche ist klein).
2. **Pragmatisch:** Toasts akzeptieren (sie sind keine Menüs) und nur die UI-Events abschalten.
3. **Radikal:** `CosmiqRealtimeClient` ohne Notification-Calls neu kompilieren – mehr Aufwand, gleiche Wirkung.

Für v1: Variante 2, für v2: Variante 1.

### 2.9 Was auf keinen Fall angefasst wird

- `ServerVerifiedCosmeticRuntime` (Ownership-Prüfung)
- `CosmiqClientAuthApi` / `CosmiqClientAuthentication` (stiller Login)
- `CosmiqRealtimeClient` / `CosmiqRealtimeEquipmentSync` / `CosmiqRealtimePackage*`
- `CosmiqWardrobeRuntime.refresh()` + Snapshot-/Equipment-Pfad
- `Native*`, `Precise*`, `CosmeticEffectRuntime`, `CapeAnimationTextureManager`
- `PlayerAppearanceRuntime`, `PlayerCape*Runtime`, `RemotePlayerCosmeticRuntime`
- `assets/cosmiq/shaders`, `assets/cosmiq/textures/entity`, Sounds
- `fabric.mod.json` `depends` (sonst startet die Mod nicht)
- Die Nested Jars (`META-INF/jars/*`) — der Core wird nicht neu gebaut

---

## 3 · Test-Strategie

### 3.1 Wo die Cosmetics liegen

Alles relativ zum **Game-Directory der Instanz** (dort, wo `options.txt` und `mods/` liegen), nicht im Config-Ordner:

```
<gameDir>/
  mods/cosmiq-0.3.7.5-26.3-fabric.jar        (dein gepatchter Build)
  cosmiq/
    dev/
      cosmetics/
        wagasa.cosmiq                        <- eigener Hut/Rücken etc.
        bamboo_swords.cosmiq
      capes/
        bird_cape.cosmiq                     <- Cape-Typ, nur .cosmiq
      emotes/                                (optional)
      equipped-cosmetic.json                 <- Launcher schreibt die Auswahl
```

Kein Resourcepack, keine Textur in `assets/`: Modell + Texturen stecken im `.cosmiq`-Paket.
`<gameDir>/config/cosmiq.json` ist der Settings-Store (kann vom Launcher vorbefüllt werden), aber **nicht**
der Ort für Cosmetics.

### 3.2 JSON-Struktur (verbindlich)

`<gameDir>/cosmiq/dev/equipped-cosmetic.json`:

```json
{
  "schemaVersion": "cosmiq.local-equipped.v3",
  "selections": [
    {
      "fileName": "wagasa.cosmiq",
      "projectId": "bamboo:wagasa",
      "sourceRevision": 1,
      "textureVariantId": "default"
    }
  ]
}
```

Regeln (aus `LocalEquippedCosmeticStore` verifiziert):

- `schemaVersion` exakt `cosmiq.local-equipped.v3` (v1/v2 werden migriert, aber nicht neu schreiben)
- `selections`: 1–6 Einträge; leere Liste = nichts equipped (Datei wird gelöscht)
- `fileName`: exakt der Dateiname im `cosmetics/`- bzw. `capes/`-Ordner (kein Pfad, keine Unterordner)
- `projectId`: muss dem Manifest des Pakets entsprechen, Muster `namespace:path` (z. B. `bamboo:wagasa`)
- `sourceRevision`: positive Ganzzahl, muss zum Manifest passen
- `textureVariantId`: muss eine Variante des Pakets sein; `default` ist immer vorhanden
- Datei max. 16 KB, wird atomar ersetzt; bei Mismatch wird der Eintrag verworfen

### 3.3 Vom `.bbmodel` zum `.cosmiq`

Der `.cosmiq`-Container ist **kein ZIP**, sondern ein eigenes Binärformat (`COSMIQCP`, Container v1).
Nicht von Hand schreiben. Es gibt einen headless Konverter im Core:

```java
LegacyBbmodelConverter.MetadataInput meta = new LegacyBbmodelConverter.MetadataInput(
    "bamboo:wagasa",          // projectId
    "Wagasa",                 // displayName
    "Bamboo",                 // creatorName
    "Bamboo Cosmetics",       // description
    List.of("bamboo", "hat"), // tags, max. 8
    List.of("cosmiq:slot/head"), // bodySlots
    CosmeticModelVariant.UNIVERSAL,
    CosmeticPreviewCamera.DEFAULT
);
new LegacyBbmodelConverter().convertToDirectory(bbmodel, outputDir, meta);
// -> outputDir/<stem>.cosmiq
```

**Voraussetzung an die Modelle (wichtig für euren Bestand):**

Eure aktuellen Dateien unter `BambooContent/Cosmetics/` sind **keine echten Blockbench-Projekte**. Beispiel
`Wagasa/Wagasa.json` hat nur `format_version`, `credit`, `textures`, `elements`, `groups` – es fehlen `meta`,
`resolution` und `outliner`, und die Texturen liegen als separate PNGs daneben. `LegacyBbmodelConverter`
verlangt aber `meta` als Map und wirft sonst
„The legacy file is missing Blockbench project metadata“.

Das heißt: **jedes Cosmetic einmal in Blockbench öffnen und als `.bbmodel` exportieren** (Texturen eingebettet,
Outliner/Gruppen intakt). Erst diese Exporte gehen durch den Konverter. Die `assets/cosmiq/test_content/*.cosmiq`
im Jar (`bat-wings-head.cosmiq`, `BigBoyJump.cosmiq`) sind gute Referenzpakete, um die Pipeline vorher zu testen.

Der Konverter:

- bettet Texturen als Base64 ins Modell ein
- validiert das Ergebnis durch erneutes Importieren
- prüft, dass Geometrie/Animation/Texturen unverändert sind
- schreibt atomar `<stem>.cosmiq`

**Metadata-Regeln** (`CosmeticMetadata`):

| Feld | Regel |
|---|---|
| `projectId` | `[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._/-]{0,126}` |
| `displayName`, `creatorName` | Pflicht, ≤ 128 Zeichen |
| `tags` | ≤ 8, je `[a-z0-9][a-z0-9._-]{0,23}` |
| `bodySlots` | Pflicht, ≤ 8, nur `cosmiq:slot/head`, `/body`, `/back`, `/arms`, `/legs`, `/multi` |
| `modelVariant` | `UNIVERSAL`, `WIDE`, `SLIM` |
| `textureVariants` | 1–10; `default` muss existieren |
| `previewCamera` | yaw −180…180, pitch −45…45, zoom 0.5…2.0, targetY −2…4 |

**Anker:** Cosmiq platziert Modellgruppen über Anker. Ohne Cosmiq-Plugin im Blockbench-Projekt musst du die
Gruppen konventionell benennen oder `cosmiq_anchor` setzen. Gültige Anker:
`cosmiq:player/root`, `/hitbox`, `/waist`, `/body` (alias `/torso`), `/head`, `/back`, `/left_arm` (alias
`/left_shoulder`), `/right_arm`, `/left_leg`, `/right_leg`.
Unbekannter Anker → Warnung + Fallback auf `body`.

**CLI (implementiert):** `cosmiq-patch/cli` baut den eigenständigen
`cosmiq-patch/dist/cosmiq-cli.jar`. Er enthält die CLI-Klassen plus alle Nested-Jars als Fatjar
(Java 25), wird also mit dem Java gestartet, das der Launcher ohnehin für Minecraft 26.3 verwaltet.

```bash
cd cosmiq-patch/cli
python build.py
java -jar ../dist/cosmiq-cli.jar --help
```

Der CLI nutzt für Dateiablage und State **Cosmiqs eigene Klassen** (`LegacyBbmodelConverter`,
`LocalCosmeticCatalogue`, `LocalEquippedCosmeticStore`). Damit schreibt er exakt das Schema v3 und
dieselben Validierungen, die auch die Mod beim Laden anwendet – kein nachgebautes JSON.

```bash
# 1) Nur konvertieren (Launcher kann die Datei selbst verteilen)
java -jar cosmiq-cli.jar convert "Duck Crown.bbmodel" --out ./out \
  --id bamboo:duck_crown --name "Duck Crown" --anchor head --tag hat

# 2) Konvertieren + in die Instanz legen + equippen (ein Schritt)
java -jar cosmiq-cli.jar install "Duck Crown.bbmodel" --game-dir "<instance>" \
  --id bamboo:duck_crown --name "Duck Crown" --anchor head

# 3) Fertiges Paket installieren, Listen, Equip ändern
java -jar cosmiq-cli.jar install duck_crown.cosmiq --game-dir "<instance>" --no-equip
java -jar cosmiq-cli.jar list "<instance>"
java -jar cosmiq-cli.jar equip "<instance>" duck_crown.cosmiq --texture-variant default
java -jar cosmiq-cli.jar unequip "<instance>" duck_crown.cosmiq
```

Jeder Befehl gibt **ein JSON-Objekt** auf stdout aus (Fehler auf stderr, Exit-Code 1/2), damit der
Electron-Launcher nicht parsen muss. `install` liefert u. a. `file`, `projectId`, `sourceRevision`,
`textureVariantId` und den kompletten `state` zurück.

**Anker setzen:** `--anchor head` (auch `body`, `back`, `root`, `waist`, `left_arm`, `right_arm`,
`left_leg`, `right_leg`) schreibt `cosmiq_anchor` auf die Top-Level-Gruppen bzw. – bei Modellen ohne
Gruppen – auf den Top-Level-Cube. Das Quell-`.bbmodel` bleibt unverändert; der Patch passiert in einer
temporären Kopie. Untergruppen erben den Anker. Ohne `--anchor` gilt die Blockbench-Konvention
(Gruppenname `Head`, `Body`, `Back`, …) und sonst `cosmiq:player/root`.

**Ablauf im Launcher:**

1. Nutzer wählt Cosmetic im Launcher (deine eigene UI, nicht im Spiel).
2. Launcher ruft `cosmiq-cli.jar install <modell.bbmodel> --game-dir <instance> --id ... --anchor ...`
   auf. Das konvertiert, kopiert und equiptt in einem Schritt.
3. Der CLI-Dateiname ist deterministisch (`bamboo:duck_crown` → `duck_crown.cosmiq`), Updates
   ersetzen also dieselbe Datei statt Duplikate anzulegen.
4. `equipped-cosmetic.json` wird von `LocalEquippedCosmeticStore` atomar geschrieben; der Launcher
   muss die Werte nicht selbst raten.
5. Der CLI legt `cosmiq/launcher-mode.flag` bei `install` selbst an (`--no-launcher-mode`
   überspringt das); alternativ beim Spielstart `-Dbamboo.cosmetics=true` setzen.

### 3.4 Test-Matrix

| Test | Vorgehen | Erwartung |
|---|---|---|
| T1 Converter | `convert` auf `Duck Crown.bbmodel`, `Bamboo Swords.bbmodel`, `Vogel Cape.bbmodel` aus `BambooContent/Blockbench Models/` | **headless bestanden:** `.cosmiq` entsteht, Re-Import validiert, `projectId`/`sourceRevision` stimmen, Anker stehen im Paket |
| T1b Altformat | `convert` auf die alte `BambooContent/Cosmetics/Wagasa/Wagasa.json` (als `.bbmodel` kopiert) | **headless bestanden:** sauberer Fehler „cube rotation … Reopen the model in Blockbench“, Exit-Code 1, kein Crash |
| T2 Katalog | Paket in `cosmetics/` legen, Spiel starten | **bestanden:** keine Import-/Mixin-Fehler im Log, kein UI-Element |
| T3 Equip | `equipped-cosmetic.json` schreiben, Spiel starten | **bestanden (roh):** Krone/Rücken-Cosmetics rendern in Third Person; Modell-Offset noch nicht zentriert, Cape sitzt zu hoch |
| T4 Kein UI | Titel, Pause, Multiplayer, Controls öffnen | **teilweise bestanden:** Titel und Pause rein vanilla; Multiplayer/Controls noch offen |
| T5 Kein Dev | 10× aufs Logo klicken, `WardrobeLayoutDevServer`-Port prüfen | Nichts passiert, kein Browser, kein Port |
| T6 Backend | Mit Cosmiq-Account joinen, fremde Cosmiq-Cosmetics beobachten | Fremde Cosmetics rendern weiter (Ownership-Pfad intakt) |
| T7 Fehlerfall | `equipped-cosmetic.json` absichtlich mit falscher `sourceRevision` | **headless bestanden:** Eintrag wird verworfen, State-Datei wird gelöscht, kein Crash |
| T8 LAN-Relay (optional) | Host: `-Dcosmiq.testRelay=true`, zweiter Client mit identischem Build | Zweiter Client sieht das lokale Cosmetic (nur im LAN/Integrated Server) |
| T9 Public Server | Auf einem fremden Server joinen | Kein Crash, lokales Cosmetic nur bei dir sichtbar; fremde Cosmiq-Cosmetics weiter sichtbar |
| T10 Regression | `latest.log` + Mixin-Startup prüfen | Keine `MixinApplyError`, keine `ClassNotFoundException`, keine fehlenden Assets |

### 3.5 Abnahmekriterien

- Start ohne Mixin-/Class-Fehler auf Fabric 26.3 / Java 25
- 0 Cosmiq-Widgets in Titel-, Pause- und Multiplayer-Screen (T4)
- 0 `key.cosmiq.*`-Einträge in den Controls (T4)
- lokales `.cosmiq` rendert auf dem eigenen Spieler, inkl. Cape-Ersatz (T3)
- Backend-Cosmetics anderer Spieler rendern weiter (T6)
- kein Wardrobe-Temp-World-Save, kein Dev-Server-Port, kein Browser-Open (T5)
- Launcher-Auswahl → Datei → Rendering ohne manuellen In-Game-Schritt (T1–T3)

---

## 4 · Offene Entscheidungen

1. **Fork-Strategie:** Binär-Patch (schnell, wartbar gegen Updates) vs. kompletter Source-Rebuild
   (sauber, aber groß). Empfehlung: Binär-Patch für v1, Rebuild erst wenn du die Mod wirklich besitzt.
2. **Emotes:** behalten oder komplett raus? Emotes sind ein eigener Keybind-/UI-Pfad. Für „nur Cosmetics“
   würde ich sie entfernen; für „Cosmiq-Feeling“ behalten, aber das Emote-Rad ist ein In-Game-Menü.
3. **Sync:** eigenes Backend (BambooBackend) für eigene Assets vs. Cosmiq-Backend nur für Cosmiq-Cosmetics.
   Für „auf jedem öffentlichen Server sichtbar“ führt an einem eigenen Out-of-band-Kanal kein Weg vorbei.
4. **Lizenz:** ohne Freigabe von Cosmiq keine Distribution. Das ist der einzige echte Blocker.

---

## 5 · Nächster konkreter Schritt

1. Gepatchten Jar in eine Testinstanz legen und T2–T6 sowie T8–T10 fahren (echter Minecraft-Start).
   Headless erledigt sind T1, T1b, T7 und die State-Erzeugung; Rendering/UI/Backend brauchen das Spiel.
2. **Bekannte Einschränkung:** `CosmiqMfaScreen` und `CosmiqAgreementScreen` sind stumm geschaltet.
   Ein Cosmiq-Account, der bei Registrierung/MFA noch eine dieser Screens bräuchte, kann im
   headless Build nicht angelegt werden. Konten einmal mit dem Original-Client einrichten oder
   die Agreement-Annahme im Launcher/Backend vorab erledigen.
3. Sync (T8/T9) und Toasts (Phase 7) anfassen.
4. Lizenzfreigabe klären, bevor der Jar verteilt wird.
