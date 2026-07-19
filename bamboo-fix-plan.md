# Bamboo Launcher — Gesamt-Implementierungsplan

## 7 Aufgabenpakete

### 1. Modpack Update Flow
**Problem:** Kein Update-Mechanismus für bestehende Modpack-Instanzen.
**Lösung:** 
- `ModsView.tsx`: `handleUpdateModpack(instanceId)` — prüft neue Versionen, löscht alte Dateien, installiert neu
- `main.js`: IPC `update-modpack-mrpack` — löscht overrides/ im gameDir, installiert neu
- `InstancesView.tsx`: "Modpack aktualisieren"-Button im Settings-Bereich

### 2. Default RAM Allocation fix
**Problem:** RAM wird nicht zuverlässig auf Instances gespeichert.
**Lösung:** RAM-Slider-Wert in InstancesView.tsx auf Instance speichern beim Verlassen

### 3. Friends & Multiplayer Tab UX
**Problem:** Tabs leiten direkt zu Settings weiter.
**Lösung:** Redirect entfernen, "nicht angemeldet"-Text + "Zur Kontoverwaltung"-Button anzeigen

### 4. News HTTP 404 beheben
**Problem:** News laden mit 404-Fehler.
**Lösung:** URL in NewsEventsView.tsx oder api.ts von `/api/news` auf `/api/content/news` ändern

### 5. Admin Panel Backend richtig schreiben
**Problem:** Dateityp-Validierung nur im HTML-Frontend, nicht im Backend.
**Lösung:** Validierung in contentRoutes.js (assign-files, create, upload) + admin.js einbauen

### 6. Cosmetics Icons im Launcher
**Problem:** Icons werden nicht angezeigt - previewUrl leer oder API-Endpunkt fehlerhaft.
**Lösung:** contentRoutes.js fixen - image-Endpunkt richtig auf assets-Tabelle mappen, GitHub-Fallback

### 7. Theme-Sync im Admin-Panel
**Problem:** Built-in-Themes (bamboo, cherry, etc.) fehlen in der assets-Tabelle.
**Lösung:** Seed in admin.js, Sync-Endpunkt für die Built-in-Themes

## Verifikation
- `npx tsc --noEmit` — fehlerfrei
- Launcher starten — alle Tabs funktionieren
- Admin-Panel — Cosmetics-Validierung, Theme-Sync
- Modpack installieren + starten
- News laden ohne 404
- RAM wird übernommen
- Cosmetics-Icons sichtbar
