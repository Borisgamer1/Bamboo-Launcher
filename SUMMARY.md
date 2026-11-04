# Bamboo Launcher - Phase 10 Abschluss

## Bereinigung (vor Phase 10)

- Entfernt: `nul`-Dateien im Root und `server/`-Verzeichnis (leere/Garbage-Dateien)

## Phase 10 – Freunde, Profile & P2P

### Geänderte Dateien

| Datei | Änderung |
|-------|----------|
| `server/src/index.js` | **Vollständig neu geschrieben** – PostgreSQL statt JSON-Flatfiles. Neues API-Design mit allen Friends/Profile/Presence/Invitation-Endpunkten |
| `server/migrations/010-friends.sql` | **Neu** – PostgreSQL-Migration für alle Friends-Tabellen |
| `src/components/FriendsView.tsx` | **Vollständig neu geschrieben** – Von "Coming Soon"-Placeholder zu kompletter Friends-UI mit allen Bereichen |
| `src/friends/ProfileService.ts` | `setCustomStatus()`-Methode hinzugefügt |
| `src/friends/NetworkLayer.ts` | `unblockUser()`-Methode hinzugefügt |
| `src/friends/FriendStore.ts` | Unverändert (wiederverwendet) |
| `src/friends/PresenceService.ts` | Unverändert (wiederverwendet) |
| `src/friends/ActivityService.ts` | Unverändert (wiederverwendet) |
| `src/friends/NotificationService.ts` | Unverändert (wiederverwendet) |
| `SUMMARY.md` | **Neu** – Diese Dokumentation |

### Neue Datenbanktabellen (PostgreSQL)

Alle Tabellen in der Datenbank `bamboo_launcher`:

| Tabelle | Zweck |
|---------|-------|
| `friend_users` | Benutzer mit Profil, Status, Aktivität, Privacy-Einstellungen |
| `friendships` | Bidirektionale akzeptierte Freundschaften (user_id ↔ friend_id) |
| `friend_requests` | Ausstehende Freundschaftsanfragen (from_user → to_user) |
| `blocked_users` | Blockierte Benutzer |
| `invitations` | Einladungen zu Instanzen/Servern (type: instance, server, realm, modpack, profile_share) |
| `presence_history` | Verlauf der Online-Status und Aktivitäten |
| `friend_notifications` | Push-Benachrichtigungen für Freundesaktivitäten |

### Neue API-Endpunkte (Port 3400)

**Auth:**
- `POST /auth/register` – Registrierung
- `POST /auth/login` – Login

**User & Profile:**
- `GET /users/search?q=` – Benutzersuche
- `GET /users/:id` – Fremdprofil (mit Privacy-Prüfung)
- `GET /profile/me` – Eigenes Profil
- `PUT /profile/me` – Profil aktualisieren
- `GET /profile/privacy` – Privacy-Einstellungen

**Friends:**
- `POST /friends/request` – Anfrage senden
- `POST /friends/accept` – Anfrage annehmen
- `POST /friends/decline` – Anfrage ablehnen
- `POST /friends/remove` – Freund entfernen
- `POST /friends/block` – Benutzer blockieren
- `POST /friends/unblock` – Blockierung aufheben
- `GET /friends` – Freundesliste
- `GET /friends/requests` – Eingehende Anfragen
- `GET /friends/requests/sent` – Gesendete Anfragen
- `GET /friends/blocked` – Blockierte Benutzer
- `GET /friends/suggestions` – Freundesvorschläge

**Presence:**
- `PUT /presence/status` – Status setzen
- `PUT /presence/activity` – Aktivität setzen
- `GET /presence/online` – Online-Freunde abrufen

**Invitations:**
- `POST /invitations/send` – Einladung senden
- `POST /invitations/respond` – Auf Einladung antworten
- `GET /invitations` – Offene Einladungen

**Notifications:**
- `GET /notifications` – Benachrichtigungen abrufen
- `PUT /notifications/read/:id` – Einzeln als gelesen markieren
- `PUT /notifications/read-all` – Alle als gelesen markieren

**P2P (vorbereitet):**
- `GET /p2p/status` – P2P-Status
- `POST /p2p/signal` – WebRTC-Signaling (vorbereitet)

**WebSocket (Port 3400 + 3401):**
- `auth` – Authentifizierung + Online-Status
- `status` – Status-Update broadcast
- `activity` – Aktivitäts-Update broadcast
- `ping` – Keepalive
- Events: `friend_online`, `friend_offline`, `friend_status`, `friend_activity`, `friend_request`, `friend_request_accepted`, `friend_added`, `friend_profile_updated`, `invitation`, `invitation_response`, `p2p_signal`

### Frontend-Komponenten

**FriendsView** (`src/components/FriendsView.tsx`):
- **Sidebar**: Eigener Status-Picker, Navigation (Freunde, Anfragen, Suche, Profil, Einstellungen), Verbindungsstatus
- **Freundesliste**: Online-Status, benutzerdefinierter Status, Rich Presence Details (Version, Modloader, Sitzungsdauer), "Zuletzt online" für Offline-Freunde, Filter (Alle/Online/Ausstehend), Kontextmenü (Entfernen/Blockieren)
- **Freundesanfragen**: Eingehende Anfragen mit Annehmen/Ablehnen
- **Benutzersuche**: Debounced-Suche, Freund-Status-Anzeige, Hinzufügen-Button
- **Profil (Ansicht)**: Banner, Avatar, Anzeigename, Status, Custom-Status, Bio, Statistiken (Freunde, Online, Level)
- **Profil (Bearbeiten)**: Anzeigename, Custom-Status, Bio, Lieblingsspiel, Lieblings-Instanz
- **Benachrichtigungen**: Alle Benachrichtigungen mit Lesestatus, "Alle gelesen"-Button
- **Einstellungen**: Privatsphäre (Profil sichtbar für, Freundschaftsanfragen), Verbindungsstatus, P2P-Status
- **Friend-Detail-Panel**: Animiertes Seitenpanel mit vollständigem Profil + Aktionen

### Durchgeführte Tests

| Test | Status |
|------|--------|
| TypeScript `tsc --noEmit` | ✅ Fehlerfrei |
| Vite Build | ✅ Erfolgreich (FriendsView: 40 kB) |
| Backend PostgreSQL-Tabellen (CREATE TABLE IF NOT EXISTS) | ✅ Automatisch bei Serverstart |
| `setCustomStatus` in ProfileService | ✅ Hinzugefügt |
| `unblockUser` in NetworkLayer | ✅ Hinzugefügt |
| Backend-Logging (catch-Blöcke) | ✅ Verbessert |
| Profile-Edit-Initialisierung | ✅ Behoben (sync bei Mode-Wechsel) |

### Noch offen (für spätere Phasen)

- **Cosmetics im Profil anzeigen** (Datenbank + API vorbereitet)
- **Badges-Verwaltung** (Datenbank vorbereitet)
- **Einladungs-Frontend-Flow** (Backend komplett, Frontend-UI folgt)
- **Launcher-Level-System** (Datenbank vorbereitet)
- **P2P-Direktverbindungen aktivieren** (Signaling-API vorbereitet)
- **Sprachkommunikation** (Architektur vorbereitet)
