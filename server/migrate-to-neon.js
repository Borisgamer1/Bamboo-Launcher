// ============================================================
// server/migrate-to-neon.js — Migration: Lokal → Neon Cloud
// ============================================================
// Kopiert die komplette lokale "bamboo_launcher"-Datenbank
// in eine Neon PostgreSQL Datenbank.
//
// Verwendung:
//   1. NEON_DATABASE_URL in server/.env setzen (oder als Env-Var)
//   2. node server/migrate-to-neon.js
//
// NEON_DATABASE_URL bekommst du aus dem Neon Dashboard:
//   Project → Connection Details → Connection String (PSL)
//   → Z.B.: postgresql://user:pass@ep-xxx.eu-west-1.aws.neon.tech/bamboo_launcher?sslmode=require
// ============================================================

require('dotenv').config();
const { Pool } = require('pg');

// ===== Konfiguration =====
// Quelle: Lokale PostgreSQL (bamboo_launcher)
const NEON_DATABASE_URL = process.env.NEON_DATABASE_URL;
const LOCAL_DB_CONFIG = {
  host: process.env.LOCAL_DB_HOST || 'localhost',
  port: parseInt(process.env.LOCAL_DB_PORT || '5432'),
  database: process.env.LOCAL_DB_NAME || 'bamboo_launcher',
  user: process.env.LOCAL_DB_USER || 'postgres',
  password: process.env.LOCAL_DB_PASSWORD || 'postgres',
};

// Ziel: Neon Cloud – wird aus den aktuellen DB_* .env Werten gelesen
const NEON_DB_CONFIG = {
  connectionString: NEON_DATABASE_URL,
};

// ===== Logging =====
const log = (...a) => console.log('[migrate-neon]', ...a);
const ok  = (...a) => console.log('  ✅', ...a);
const wrn = (...a) => console.warn('  ⚠️', ...a);
const err = (...a) => console.error('  ❌', ...a);

// ===== Tabellen in korrekter Dependency-Reihenfolge =====
// Tabellen OHNE Fremdschlüssel kommen zuerst

const TABLES_IN_ORDER = [
  // === Admin-Tabellen (keine FK-Abhängigkeiten) ===
  { name: 'admin_users', hasFK: false },
  { name: 'news', hasFK: false },
  { name: 'events', hasFK: false },
  { name: 'banners', hasFK: false },
  { name: 'cosmetics', hasFK: false },
  { name: 'content_types', hasFK: false },
  { name: 'bamboo_shares', hasFK: false },
  // === Friends-Tabellen (keine FK-Abhängigkeiten untereinander, aber auf friend_users) ===
  { name: 'friend_users', hasFK: false },

  // === Tabellen MIT Fremdschlüsseln ===
  { name: 'content_manifests', hasFK: true },    // → content_types
  { name: 'share_downloads', hasFK: true },       // → bamboo_shares
  { name: 'friendships', hasFK: true },            // → friend_users
  { name: 'friend_requests', hasFK: true },        // → friend_users
  { name: 'blocked_users', hasFK: true },          // → friend_users
  { name: 'invitations', hasFK: true },            // → friend_users
  { name: 'presence_history', hasFK: true },       // → friend_users
  { name: 'friend_notifications', hasFK: true },   // → friend_users
  { name: 'profile_exports', hasFK: false },
  { name: 'profile_imports', hasFK: false },
];

// ============================================================
// CREATE TABLE Statements (exakt aus admin.js, index.js, share.js)
// ============================================================
const CREATE_TABLE_SQL = {
  admin_users: `CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(64) UNIQUE NOT NULL,
    display_name VARCHAR(128) NOT NULL DEFAULT '',
    password_hash VARCHAR(256) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login TIMESTAMPTZ
  )`,

  news: `CREATE TABLE IF NOT EXISTS news (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(256) NOT NULL,
    subtitle VARCHAR(512) DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    banner_url VARCHAR(1024) DEFAULT '',
    category VARCHAR(64) NOT NULL DEFAULT 'general',
    author VARCHAR(128) NOT NULL DEFAULT 'Bamboo Team',
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_visible BOOLEAN NOT NULL DEFAULT true,
    is_pinned BOOLEAN NOT NULL DEFAULT false,
    game_version VARCHAR(32) DEFAULT '',
    tags TEXT[] DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0
  )`,

  events: `CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(256) NOT NULL,
    subtitle VARCHAR(512) DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    banner_url VARCHAR(1024) DEFAULT '',
    category VARCHAR(64) NOT NULL DEFAULT 'general',
    start_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    end_date TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_visible BOOLEAN NOT NULL DEFAULT true,
    priority INTEGER NOT NULL DEFAULT 0,
    author VARCHAR(128) NOT NULL DEFAULT 'Bamboo Team',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  banners: `CREATE TABLE IF NOT EXISTS banners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(256) NOT NULL,
    image_url VARCHAR(1024) NOT NULL DEFAULT '',
    description VARCHAR(512) DEFAULT '',
    click_target VARCHAR(1024) DEFAULT '',
    click_type VARCHAR(32) NOT NULL DEFAULT 'external',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  cosmetics: `CREATE TABLE IF NOT EXISTS cosmetics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(128) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type VARCHAR(32) NOT NULL DEFAULT 'cape' CHECK(type IN ('cape','aura','hat','ear','rank','other')),
    rarity VARCHAR(32) NOT NULL DEFAULT 'common' CHECK(rarity IN ('common','rare','epic','legendary','mythic')),
    preview_url VARCHAR(1024) DEFAULT '',
    image_url VARCHAR(1024) DEFAULT '',
    model_url VARCHAR(1024) DEFAULT '',
    accent_color VARCHAR(32) DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  content_types: `CREATE TABLE IF NOT EXISTS content_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(128) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    current_version INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT true,
    file_pattern VARCHAR(256) DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  content_manifests: `CREATE TABLE IF NOT EXISTS content_manifests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type_id UUID NOT NULL REFERENCES content_types(id) ON DELETE CASCADE,
    file_path VARCHAR(512) NOT NULL,
    file_hash VARCHAR(64) NOT NULL,
    file_size BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    mime_type VARCHAR(128) DEFAULT 'application/octet-stream',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(content_type_id, file_path)
  )`,

  friend_users: `CREATE TABLE IF NOT EXISTS friend_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(64) UNIQUE NOT NULL,
    display_name VARCHAR(128) NOT NULL DEFAULT '',
    password_hash VARCHAR(256) NOT NULL,
    avatar VARCHAR(512) DEFAULT '🎋',
    banner VARCHAR(512) DEFAULT '',
    bio TEXT DEFAULT '',
    accent_color VARCHAR(32) DEFAULT '#4CAF50',
    custom_status VARCHAR(128) DEFAULT '',
    launcher_version VARCHAR(32) DEFAULT '0.1.0',
    favorite_game VARCHAR(128) DEFAULT '',
    favorite_instance VARCHAR(256) DEFAULT '',
    launcher_level INTEGER NOT NULL DEFAULT 1,
    badges TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_online TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status VARCHAR(16) NOT NULL DEFAULT 'offline' CHECK(status IN ('online','busy','away','dnd','invisible','offline')),
    activity JSONB DEFAULT '{"type":"offline"}'::jsonb,
    friend_count INTEGER NOT NULL DEFAULT 0,
    privacy_settings JSONB DEFAULT '{"statusVisible":"everyone","profileVisible":"friends","whoCanAdd":"everyone","activitiesVisible":"friends","invitationsAllowed":"friends","currentProfileVisible":"friends"}'::jsonb
  )`,

  bamboo_shares: `CREATE TABLE IF NOT EXISTS bamboo_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    share_code VARCHAR(16) UNIQUE NOT NULL,
    author_id UUID,
    author_name VARCHAR(128) NOT NULL DEFAULT 'Unknown',
    title VARCHAR(256) NOT NULL,
    description TEXT DEFAULT '',
    minecraft_version VARCHAR(32) NOT NULL,
    modloader VARCHAR(32) NOT NULL DEFAULT 'Vanilla',
    modloader_version VARCHAR(32) DEFAULT '',
    file_size BIGINT NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    mod_count INTEGER NOT NULL DEFAULT 0,
    resourcepack_count INTEGER NOT NULL DEFAULT 0,
    shader_count INTEGER NOT NULL DEFAULT 0,
    datapack_count INTEGER NOT NULL DEFAULT 0,
    world_count INTEGER NOT NULL DEFAULT 0,
    download_count INTEGER NOT NULL DEFAULT 0,
    file_storage_path VARCHAR(512) NOT NULL DEFAULT '',
    file_hash VARCHAR(64) NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  share_downloads: `CREATE TABLE IF NOT EXISTS share_downloads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    share_id UUID NOT NULL REFERENCES bamboo_shares(id) ON DELETE CASCADE,
    downloader_ip VARCHAR(45) DEFAULT '',
    downloader_username VARCHAR(128) DEFAULT '',
    user_agent TEXT DEFAULT '',
    downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  profile_exports: `CREATE TABLE IF NOT EXISTS profile_exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id VARCHAR(128) NOT NULL,
    instance_name VARCHAR(256) NOT NULL,
    minecraft_version VARCHAR(32) NOT NULL,
    modloader VARCHAR(32) NOT NULL DEFAULT 'Vanilla',
    export_format VARCHAR(16) NOT NULL CHECK(export_format IN ('bamboo','mrpack','zip')),
    file_size BIGINT NOT NULL DEFAULT 0,
    file_path VARCHAR(512) NOT NULL DEFAULT '',
    included_content TEXT[] DEFAULT '{}',
    is_bamboo_share BOOLEAN NOT NULL DEFAULT false,
    share_code VARCHAR(16) DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  profile_imports: `CREATE TABLE IF NOT EXISTS profile_imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_format VARCHAR(16) NOT NULL CHECK(import_format IN ('bamboo','mrpack','zip')),
    source_file VARCHAR(512) NOT NULL DEFAULT '',
    source_code VARCHAR(16) DEFAULT NULL,
    title VARCHAR(256) NOT NULL,
    minecraft_version VARCHAR(32) NOT NULL,
    modloader VARCHAR(32) NOT NULL DEFAULT 'Vanilla',
    file_size BIGINT NOT NULL DEFAULT 0,
    mod_count INTEGER NOT NULL DEFAULT 0,
    resourcepack_count INTEGER NOT NULL DEFAULT 0,
    shader_count INTEGER NOT NULL DEFAULT 0,
    datapack_count INTEGER NOT NULL DEFAULT 0,
    world_count INTEGER NOT NULL DEFAULT 0,
    had_conflicts BOOLEAN NOT NULL DEFAULT false,
    conflict_details JSONB DEFAULT '[]'::jsonb,
    was_successful BOOLEAN NOT NULL DEFAULT false,
    error_message TEXT DEFAULT '',
    imported_instance_id VARCHAR(128) DEFAULT '',
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  friendships: `CREATE TABLE IF NOT EXISTS friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    friend_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, friend_id),
    CHECK(user_id <> friend_id)
  )`,

  friend_requests: `CREATE TABLE IF NOT EXISTS friend_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    to_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    message VARCHAR(256) DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(from_user, to_user)
  )`,

  blocked_users: `CREATE TABLE IF NOT EXISTS blocked_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, blocked_id)
  )`,

  invitations: `CREATE TABLE IF NOT EXISTS invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    to_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    type VARCHAR(32) NOT NULL DEFAULT 'instance' CHECK(type IN ('instance','server','realm','modpack','profile_share')),
    detail VARCHAR(256) DEFAULT '',
    payload JSONB DEFAULT '{}'::jsonb,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMPTZ
  )`,

  presence_history: `CREATE TABLE IF NOT EXISTS presence_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL,
    activity JSONB DEFAULT '{}'::jsonb,
    session_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  friend_notifications: `CREATE TABLE IF NOT EXISTS friend_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    from_user UUID REFERENCES friend_users(id) ON DELETE CASCADE,
    type VARCHAR(32) NOT NULL DEFAULT 'friend_request' CHECK(type IN ('friend_online','friend_started_game','friend_request','request_accepted','profile_updated','invitation')),
    message TEXT DEFAULT '',
    payload JSONB DEFAULT '{}'::jsonb,
    read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
};

// ============================================================
// Index-Definitionen
// ============================================================
const INDEX_SQL = {
  news: [
    'CREATE INDEX IF NOT EXISTS idx_news_category ON news(category)',
    'CREATE INDEX IF NOT EXISTS idx_news_pinned ON news(is_pinned)',
    'CREATE INDEX IF NOT EXISTS idx_news_visible ON news(is_visible)',
    'CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at DESC)',
  ],
  events: [
    'CREATE INDEX IF NOT EXISTS idx_events_active ON events(is_active)',
    'CREATE INDEX IF NOT EXISTS idx_events_visible ON events(is_visible)',
    'CREATE INDEX IF NOT EXISTS idx_events_dates ON events(start_date, end_date)',
  ],
  banners: [
    'CREATE INDEX IF NOT EXISTS idx_banners_active ON banners(is_active)',
    'CREATE INDEX IF NOT EXISTS idx_banners_order ON banners(sort_order)',
  ],
  cosmetics: [
    'CREATE INDEX IF NOT EXISTS idx_cosmetics_type ON cosmetics(type)',
    'CREATE INDEX IF NOT EXISTS idx_cosmetics_rarity ON cosmetics(rarity)',
    'CREATE INDEX IF NOT EXISTS idx_cosmetics_active ON cosmetics(is_active)',
  ],
  content_types: [
    'CREATE INDEX IF NOT EXISTS idx_content_types_slug ON content_types(slug)',
  ],
  content_manifests: [
    'CREATE INDEX IF NOT EXISTS idx_content_manifests_type ON content_manifests(content_type_id)',
    'CREATE INDEX IF NOT EXISTS idx_content_manifests_version ON content_manifests(version)',
  ],
  bamboo_shares: [
    'CREATE INDEX IF NOT EXISTS idx_bamboo_shares_code ON bamboo_shares(share_code)',
    'CREATE INDEX IF NOT EXISTS idx_bamboo_shares_active ON bamboo_shares(is_active)',
    'CREATE INDEX IF NOT EXISTS idx_bamboo_shares_created ON bamboo_shares(created_at DESC)',
  ],
  share_downloads: [
    'CREATE INDEX IF NOT EXISTS idx_share_downloads_share ON share_downloads(share_id)',
  ],
  friend_users: [
    'CREATE INDEX IF NOT EXISTS idx_fu_username ON friend_users(username)',
    'CREATE INDEX IF NOT EXISTS idx_fu_status ON friend_users(status)',
    'CREATE INDEX IF NOT EXISTS idx_fu_display_name ON friend_users(display_name)',
  ],
  friendships: [
    'CREATE INDEX IF NOT EXISTS idx_fs_user ON friendships(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_fs_friend ON friendships(friend_id)',
  ],
  friend_requests: [
    'CREATE INDEX IF NOT EXISTS idx_fr_from ON friend_requests(from_user)',
    'CREATE INDEX IF NOT EXISTS idx_fr_to ON friend_requests(to_user)',
  ],
  blocked_users: [
    'CREATE INDEX IF NOT EXISTS idx_bu_user ON blocked_users(user_id)',
  ],
  invitations: [
    'CREATE INDEX IF NOT EXISTS idx_inv_from ON invitations(from_user)',
    'CREATE INDEX IF NOT EXISTS idx_inv_to ON invitations(to_user)',
    'CREATE INDEX IF NOT EXISTS idx_inv_status ON invitations(status)',
  ],
  presence_history: [
    'CREATE INDEX IF NOT EXISTS idx_ph_user ON presence_history(user_id)',
  ],
  friend_notifications: [
    'CREATE INDEX IF NOT EXISTS idx_fn_user ON friend_notifications(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_fn_unread ON friend_notifications(user_id, read)',
  ],
};

// ============================================================
// Helper: Daten aus einer Tabelle lesen
// ============================================================
async function readAllData(pool, tableName) {
  try {
    const r = await pool.query(`SELECT * FROM "${tableName}"`);
    return r.rows;
  } catch (e) {
    if (e.code === '42P01') return []; // table doesn't exist
    throw e;
  }
}

// ============================================================
// Helper: Daten in eine Tabelle einfügen
// ============================================================
async function insertData(pool, tableName, rows) {
  if (rows.length === 0) {
    ok(`${tableName}: 0 Zeilen (leer)`);
    return 0;
  }

  const colNames = Object.keys(rows[0]);
  const cols = colNames.map(c => `"${c}"`).join(', ');
  const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');
  const insertSQL = `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

  let inserted = 0;
  for (const row of rows) {
    try {
      const values = colNames.map(c => row[c]);
      await pool.query(insertSQL, values);
      inserted++;
    } catch (e) {
      wrn(`${tableName}: Zeile ${row.id || row.share_code || '(keine ID)'} übersprungen: ${e.message}`);
    }
  }

  ok(`${tableName}: ${inserted}/${rows.length} Zeilen kopiert`);
  return inserted;
}

// ============================================================
// Spezialfall: Cosmetics (altes Schema → neues Schema)
// Das alte Schema hatte: id, name, description, category, rarity,
//   icon_path, preview_image, tags, version, enabled, created_at, updated_at
// Das neue Schema hat: id, slug, name, description, type, rarity,
//   preview_url, image_url, model_url, accent_color, is_active, sort_order, ...
// ============================================================
async function copyCosmeticsData(localPool, neonPool) {
  const rows = await readAllData(localPool, 'cosmetics');
  if (rows.length === 0) {
    ok('cosmetics: 0 Zeilen (leer)');
    return 0;
  }

  // Prüfen ob altes Schema (hat 'category' Spalte)
  const hasOldSchema = 'category' in rows[0];

  if (!hasOldSchema) {
    // Neues Schema → normal kopieren
    return insertData(neonPool, 'cosmetics', rows);
  }

  // Altes Schema → migrieren
  const typeMap = { 'Head': 'hat', 'Cape': 'cape', 'Hat': 'hat', 'Ear': 'ear', 'Rank': 'rank', 'Other': 'other' };
  const now = new Date().toISOString();
  let inserted = 0;

  for (const old of rows) {
    try {
      const slug = (old.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
      const type = typeMap[old.category] || 'other';
      const rarity = (old.rarity || 'common').toLowerCase();
      const isActive = old.enabled === true || old.enabled === 'true' || old.enabled == null;

      await neonPool.query(`
        INSERT INTO cosmetics (id, slug, name, description, type, rarity, image_url, is_active, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (slug) DO NOTHING
      `, [
        old.id, slug, old.name, old.description || '', type, rarity,
        old.icon_path || old.preview_image || '', isActive,
        old.created_at || now, old.updated_at || now
      ]);
      inserted++;
    } catch (e) {
      wrn(`cosmetics: Zeile ${old.id || '(keine ID)'} übersprungen: ${e.message}`);
    }
  }

  ok(`cosmetics: ${inserted}/${rows.length} Zeilen migriert (altes Schema → neues Schema)`);
  return inserted;
}

// ============================================================
// MAIN
// ============================================================
(async () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('   Bamboo Launcher → Neon Database Migration');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  // --- Prüfung: NEON_DATABASE_URL ---
  if (!NEON_DATABASE_URL) {
    err('NEON_DATABASE_URL ist nicht gesetzt!');
    err('');
    err('So bekommst du die URL:');
    err('  1. Öffne https://console.neon.tech');
    err('  2. Wähle dein Projekt → Connection Details');
    err('  3. Kopiere den Connection String (beginnt mit postgresql://...)');
    err('  4. Füge ihn in server/.env ein:');
    err('     NEON_DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/bamboo_launcher?sslmode=require');
    err('');
    process.exit(1);
  }

  log('🔌 Verbinde zu lokaler Datenbank...');
  const localPool = new Pool(LOCAL_DB_CONFIG);

  log('🔌 Verbinde zu Neon Datenbank...');
  const neonPool = new Pool(NEON_DB_CONFIG);

  // --- Verbindung testen ---
  try {
    await localPool.query('SELECT 1');
    ok('Lokale DB verbunden: ' + LOCAL_DB_CONFIG.host + ':' + LOCAL_DB_CONFIG.port + '/' + LOCAL_DB_CONFIG.database);
  } catch (e) {
    err('Lokale DB nicht erreichbar: ' + e.message);
    err('Prüfe deine server/.env Datei (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)');
    process.exit(1);
  }

  try {
    await neonPool.query('SELECT 1');
    ok('Neon DB verbunden');
  } catch (e) {
    err('Neon DB nicht erreichbar: ' + e.message);
    err('Prüfe NEON_DATABASE_URL');
    process.exit(1);
  }

  console.log('');

  // --- Phase 1: Tabellen auf Neon erstellen ---
  log('📦 Phase 1: Tabellen auf Neon erstellen...');
  for (const t of TABLES_IN_ORDER) {
    const sql = CREATE_TABLE_SQL[t.name];
    if (!sql) {
      wrn(`${t.name}: Kein CREATE TABLE Statement gefunden – übersprungen`);
      continue;
    }
    try {
      await neonPool.query(sql);
      ok(`${t.name} — Tabelle erstellt`);
    } catch (e) {
      err(`${t.name}: ${e.message}`);
    }
  }

  // --- Phase 2: Indizes erstellen ---
  log('\n📦 Phase 2: Indizes erstellen...');
  for (const [tableName, indexes] of Object.entries(INDEX_SQL)) {
    for (const idxSql of indexes) {
      try {
        await neonPool.query(idxSql);
      } catch (e) {
        wrn(`${tableName}: Index-Fehler: ${e.message}`);
      }
    }
  }
  ok('Indizes erstellt (wo vorhanden)');

  // --- Phase 3: Daten kopieren ---
  log('\n📦 Phase 3: Daten von Lokal → Neon kopieren...');
  let totalRows = 0;

  for (const t of TABLES_IN_ORDER) {
    let count;
    if (t.name === 'cosmetics') {
      // Spezialbehandlung für Cosmetics (altes Schema möglich)
      count = await copyCosmeticsData(localPool, neonPool);
    } else {
      const rows = await readAllData(localPool, t.name);
      count = await insertData(neonPool, t.name, rows);
    }
    totalRows += count;
  }

  // --- Phase 4: Verifikation ---
  console.log('');
  log('📊 Phase 4: Verifikation – Zeilen zählen...');
  console.log('');

  let allOk = true;
  for (const t of TABLES_IN_ORDER) {
    try {
      const r = await neonPool.query(`SELECT COUNT(*) AS cnt FROM "${t.name}"`);
      const localR = await localPool.query(`SELECT COUNT(*) AS cnt FROM "${t.name}"`);
      const neonCount = parseInt(r.rows[0].cnt);
      const localCount = parseInt(localR.rows[0].cnt);
      const status = neonCount === localCount ? '✅' : '⚠️';
      console.log(`   ${status} ${t.name.padEnd(22)} Lokal: ${String(localCount).padStart(5)}  →  Neon: ${String(neonCount).padStart(5)}`);
      if (neonCount !== localCount) allOk = false;
    } catch (e) {
      wrn(`${t.name}: ${e.message}`);
    }
  }

  // --- Cleanup ---
  await localPool.end();
  await neonPool.end();

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  if (allOk) {
    console.log('   ✅ Migration erfolgreich abgeschlossen!');
    console.log(`   📊 ${totalRows} Zeilen insgesamt kopiert`);
  } else {
    console.log('   ⚠️  Migration mit Abweichungen abgeschlossen');
    console.log('     Prüfe die ⚠️ -Einträge oben');
  }
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('  Nächste Schritte:');
  console.log('  1. In server/.env: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME');
  console.log('     durch die Neon-Zugangsdaten ersetzen');
  console.log('  2. Backend neustarten');
  console.log('  3. Testen ob alles läuft');
  console.log('');

  process.exit(allOk ? 0 : 1);
})();
