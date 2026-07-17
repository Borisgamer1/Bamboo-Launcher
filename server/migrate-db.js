// server/migrate-db.js — Migration: bambooadmin → bamboo_launcher
// Führt sämtliche Daten aus der versehentlich erstellten "bambooadmin"-Datenbank
// in die Hauptdatenbank "bamboo_launcher" zusammen.
// 
// Usage: node migrate-db.js
//
// WICHTIG: Vor dem ersten Start des Backends nach der Migration ausführen!

require('dotenv').config();
const { Pool } = require('pg');

const PG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
};

const log = (...a) => console.log('[migrate]', ...a);
const err = (...a) => console.error('[migrate]', ...a);

// ============================================================
// STEP 0: Read all data from BOTH databases
// ============================================================
async function readData(pool, table) {
  try {
    const r = await pool.query('SELECT * FROM ' + table);
    return r.rows;
  } catch (e) {
    if (e.code === '42P01') return []; // table doesn't exist
    throw e;
  }
}

async function saveCosmetics(pool) {
  // Old bamboo_launcher schema: id, name, description, category, rarity, icon_path, preview_image, tags, version, enabled, created_at, updated_at
  const rows = await readData(pool, 'cosmetics');
  return rows;
}

async function saveUsers(pool) {
  return await readData(pool, 'users');
}

// ============================================================
// STEP 1: Drop old-schema tables in bamboo_launcher
// ============================================================
async function dropOldTables(pool) {
  const tables = ['banners', 'cosmetics', 'events', 'news'];
  for (const t of tables) {
    try {
      await pool.query('DROP TABLE IF EXISTS ' + t + ' CASCADE');
      log('Dropped old table: ' + t);
    } catch (e) {
      err('Could not drop ' + t + ':', e.message);
    }
  }
}

// ============================================================
// STEP 2: Create correct tables in bamboo_launcher
// (Mirrors the CREATE TABLE statements from admin.js)
// ============================================================
async function createTables(pool) {
  // admin_users
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(64) UNIQUE NOT NULL,
    display_name VARCHAR(128) NOT NULL DEFAULT '',
    password_hash VARCHAR(256) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login TIMESTAMPTZ
  )`);
  log('Created: admin_users');

  // news
  await pool.query(`CREATE TABLE IF NOT EXISTS news (
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
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_news_category ON news(category)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_news_pinned ON news(is_pinned)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_news_visible ON news(is_visible)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at DESC)');
  log('Created: news + indexes');

  // events
  await pool.query(`CREATE TABLE IF NOT EXISTS events (
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
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_events_active ON events(is_active)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_events_visible ON events(is_visible)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_events_dates ON events(start_date, end_date)');
  log('Created: events + indexes');

  // banners
  await pool.query(`CREATE TABLE IF NOT EXISTS banners (
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
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_banners_active ON banners(is_active)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_banners_order ON banners(sort_order)');
  log('Created: banners + indexes');

  // cosmetics
  await pool.query(`CREATE TABLE IF NOT EXISTS cosmetics (
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
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cosmetics_type ON cosmetics(type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cosmetics_rarity ON cosmetics(rarity)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cosmetics_active ON cosmetics(is_active)');
  log('Created: cosmetics + indexes');

  // content_types
  await pool.query(`CREATE TABLE IF NOT EXISTS content_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(128) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    current_version INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT true,
    file_pattern VARCHAR(256) DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_content_types_slug ON content_types(slug)');
  log('Created: content_types');

  // content_manifests
  await pool.query(`CREATE TABLE IF NOT EXISTS content_manifests (
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
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_content_manifests_type ON content_manifests(content_type_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_content_manifests_version ON content_manifests(version)');
  log('Created: content_manifests');
}

// ============================================================
// STEP 3: Copy data from bambooadmin → bamboo_launcher
// ============================================================
async function copyData(srcPool, dstPool, table) {
  const rows = await readData(srcPool, table);
  if (rows.length === 0) {
    log('  ' + table + ': 0 Zeilen zu kopieren');
    return 0;
  }

  const colNames = Object.keys(rows[0]);
  const placeholders = colNames.map((_, i) => '$' + (i + 1)).join(', ');
  const cols = colNames.join(', ');
  let count = 0;

  for (const row of rows) {
    try {
      const values = colNames.map(c => row[c]);
      await dstPool.query(
        'INSERT INTO ' + table + ' (' + cols + ') VALUES (' + placeholders + ') ON CONFLICT DO NOTHING',
        values
      );
      count++;
    } catch (e) {
      err('  Fehler beim Kopieren von ' + table + ' (ID=' + row.id + '): ' + e.message);
    }
  }
  log('  ' + table + ': ' + count + '/' + rows.length + ' Zeilen kopiert');
  return count;
}

// ============================================================
// STEP 4: Migrate old cosmetics to new schema
// ============================================================
async function migrateCosmetics(dstPool, oldCosmetics) {
  // Map old bamboo_launcher cosmetics (name, description, category, rarity, icon_path, preview_image, enabled)
  // to new schema (slug, name, description, type, rarity, preview_url, image_url, model_url, accent_color, is_active)
  const typeMap = { 'Head': 'hat', 'Cape': 'cape', 'Hat': 'hat', 'Ear': 'ear', 'Rank': 'rank', 'Other': 'other' };
  let count = 0;

  for (const old of oldCosmetics) {
    try {
      const id = old.id;
      const slug = old.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const type = typeMap[old.category] || 'other';
      const rarity = (old.rarity || 'common').toLowerCase();
      const isActive = old.enabled === true || old.enabled === 'true' || old.enabled === null || old.enabled === undefined;
      const now = new Date().toISOString();

      await dstPool.query(
        `INSERT INTO cosmetics (id, slug, name, description, type, rarity, image_url, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (slug) DO NOTHING`,
        [id, slug, old.name, old.description || '', type, rarity, old.icon_path || old.preview_image || '', isActive, old.created_at || now, old.updated_at || now]
      );
      count++;
      log('  Cosmetic migriert: ' + old.name + ' (slug=' + slug + ', type=' + type + ', rarity=' + rarity + ')');
    } catch (e) {
      err('  Fehler bei Cosmetic ' + old.name + ': ' + e.message);
    }
  }
  return count;
}

// ============================================================
// MAIN
// ============================================================
(async () => {
  log('=== Starte Migration bambooadmin → bamboo_launcher ===\n');

  // Connect to both databases
  const srcPool = new Pool({ ...PG, database: 'bambooadmin' });
  const dstPool = new Pool({ ...PG, database: 'bamboo_launcher' });

  try {
    // Phase 0: Save data from bamboo_launcher that we need to preserve
    log('\n--- Phase 0: Daten aus bamboo_launcher sichern ---');
    const oldCosmetics = await saveCosmetics(dstPool);
    log('  Cosmetics gesichert: ' + oldCosmetics.length + ' Einträge');
    const oldUsers = await saveUsers(dstPool);
    log('  Users gesichert: ' + oldUsers.length + ' Einträge');

    // Phase 1: Drop old-schema tables
    log('\n--- Phase 1: Alte Tabellen in bamboo_launcher löschen ---');
    await dropOldTables(dstPool);

    // Phase 2: Create correct tables
    log('\n--- Phase 2: Korrekte Tabellen in bamboo_launcher anlegen ---');
    await createTables(dstPool);

    // Phase 3: Copy data from bambooadmin to bamboo_launcher
    log('\n--- Phase 3: Daten aus bambooadmin kopieren ---');
    const tablesToCopy = ['admin_users', 'news', 'events', 'banners', 'content_types', 'content_manifests', 'cosmetics'];
    let totalCopied = 0;
    for (const t of tablesToCopy) {
      const copied = await copyData(srcPool, dstPool, t);
      totalCopied += copied;
    }
    log('  Gesamt: ' + totalCopied + ' Zeilen aus bambooadmin kopiert');

    // Phase 4: Migrate old cosmetics to new schema
    log('\n--- Phase 4: Cosmetics in neues Schema migrieren ---');
    const migratedCosmetics = await migrateCosmetics(dstPool, oldCosmetics);
    log('  Migrierte Cosmetics: ' + migratedCosmetics);

    // Phase 5: Verify
    log('\n--- Phase 5: Verifikation ---');
    // Phase 6: Apply Phase 11 migration (Profile Import/Export & Bamboo Share)
    log('\n--- Phase 6: Phase 11 Tabellen (Profile Share) anlegen ---');
    const shareMigrations = [
      `CREATE TABLE IF NOT EXISTS bamboo_shares (
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
      `CREATE INDEX IF NOT EXISTS idx_bamboo_shares_code ON bamboo_shares(share_code)`,
      `CREATE INDEX IF NOT EXISTS idx_bamboo_shares_active ON bamboo_shares(is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_bamboo_shares_created ON bamboo_shares(created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS share_downloads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        share_id UUID NOT NULL REFERENCES bamboo_shares(id) ON DELETE CASCADE,
        downloader_ip VARCHAR(45) DEFAULT '',
        downloader_username VARCHAR(128) DEFAULT '',
        user_agent TEXT DEFAULT '',
        downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_share_downloads_share ON share_downloads(share_id)`,
      `CREATE TABLE IF NOT EXISTS profile_exports (
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
      `CREATE TABLE IF NOT EXISTS profile_imports (
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
    ];
    for (const sql of shareMigrations) {
      try { await dstPool.query(sql); } catch (e) { err('Share migration error:', e.message); }
    }
    log('Phase 11 Tabellen angelegt: bamboo_shares, share_downloads, profile_exports, profile_imports');

    const verifyTables = ['admin_users', 'news', 'events', 'banners', 'cosmetics', 'content_types', 'content_manifests', 'bamboo_shares', 'share_downloads', 'profile_exports', 'profile_imports'];
    for (const t of verifyTables) {
      const r = await dstPool.query('SELECT COUNT(*) as cnt FROM ' + t);
      log('  ' + t + ': ' + r.rows[0].cnt + ' Zeilen');
    }

    log('\n=== ✅ Migration abgeschlossen ===');
    log('Nach der Migration:');
    log('  1. Connection-String in admin.js auf bamboo_launcher ändern');
    log('  2. Backend neustarten');
    log('  3. Testen');
    log('  4. Nach erfolgreichem Test: DROP DATABASE bambooadmin;');

  } catch (e) {
    err('❌ Migration fehlgeschlagen:', e.message);
    console.error(e);
    process.exit(1);
  } finally {
    await srcPool.end().catch(() => {});
    await dstPool.end().catch(() => {});
  }
})();
