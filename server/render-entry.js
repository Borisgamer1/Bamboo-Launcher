// ============================================================
// server/render-entry.js — Kombinierter Server für Render
// ============================================================
// Startet Admin-API + Friends-API + WebSocket auf EINEM Port.
// Render gibt nur process.env.PORT vor – dieser Server verbindet
// beide APIs auf diesem einen Port.
//
// Verwendung (in Render Dashboard als Start Command):
//   cd server && node render-entry.js
//
// Oder in package.json:
//   "start": "node render-entry.js"
//
// Benötigte Environment Variablen (im Render Dashboard setzen):
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (Neon)
//   JWT_SECRET (optional)
// ============================================================

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = process.env.PORT || 3001;

console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('   Bamboo Backend (Render Combined Server)');
console.log('═══════════════════════════════════════════════════');
console.log('');

// =============================================================
// Friends API inkl. WebSocket laden
// =============================================================
console.log('[render] Lade Friends API...');
const friends = require('./src/index');

// =============================================================
// Admin API laden
// =============================================================
console.log('[render] Lade Admin API...');
const admin = require('./src/admin');

// =============================================================
// Applikationen kombinieren
// =============================================================
// Admin-Routen in die Friends-App einbinden (als Middleware)
// Express kann Apps als Middleware verwenden!
friends.app.use(admin.app);

// =============================================================
// Datenbanken initialisieren
// =============================================================
async function startRender() {
  try {
    // 1. Admin DB initialisieren (erstellt Admin-Tabellen)
    console.log('[render] Admin-Datenbank wird initialisiert...');
    await admin.initDatabase();
    console.log('[render] Admin DB ✅');
    
    // 2. Friends DB initialisieren (erstellt Friends-Tabellen)
    console.log('[render] Friends-Datenbank wird initialisiert...');
    await friends.initDatabase();
    console.log('[render] Friends DB ✅');

    // 3. Content-Verzeichnis sicherstellen
    const CONTENT_ROOT = process.env.BAMBOO_CONTENT_DIR || path.join(__dirname, 'content');
    if (!fs.existsSync(CONTENT_ROOT)) {
      try {
        fs.mkdirSync(CONTENT_ROOT, { recursive: true });
        console.log('[render] Content-Verzeichnis erstellt:', CONTENT_ROOT);
      } catch (e) {
        console.warn('[render] Content-Verzeichnis Fehler:', e.message);
      }
    }

    // 5. Server starten (friends.server hat bereits WebSocket-Unterstützung)
    friends.server.listen(PORT, () => {
      console.log('');
      console.log(`   🚀 Bamboo Backend läuft auf Port ${PORT}`);
      console.log(`   📡 Admin API:    /api/auth, /api/news, /api/events, ...`);
      console.log(`   👥 Friends API:  /auth, /users, /friends, /presence, ...`);
      console.log(`   🔌 WebSocket:   ws://... Port ${PORT}`);
      console.log(`   🗄️  Neon DB:     ${process.env.DB_HOST || '?'}/${process.env.DB_NAME || '?'}`);
      console.log('');
    });
  } catch (err) {
    console.error('[render] Server-Fehler:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

startRender();
