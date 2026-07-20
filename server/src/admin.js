const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

require('dotenv').config();

const PORT = process.env.PORT || process.env.ADMIN_PORT || 3005;
const JWT_SECRET = process.env.JWT_SECRET || 'bamboo-admin-secret-2026';

// ===== PostgreSQL Connection (graceful fallback if pg not installed) =====
let pool = null;

// Use a mutable object so that dbState.connected is shared by reference
// (not passed by value) to sub-modules like assetRoutes.js.
const dbState = { connected: false };

try {
  const { Pool } = require('pg');
  const sslConfig = process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false;
  pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: sslConfig,
  });
} catch (err) {
    console.error('[admin] PostgreSQL ("pg" module) not available:', err.message);
    console.error('[admin] Please install pg: npm install pg');
    process.exit(1);
  }

async function initDatabase() {
  if (!pool) { throw new Error('PostgreSQL pool not initialized'); }
  try {
    // Auto-create database if it doesn't exist
    const pgHost = process.env.DB_HOST;
    const pgPort = process.env.DB_PORT || '5432';
    const pgUser = process.env.DB_USER;
    const pgPass = process.env.DB_PASSWORD;
    const { Client } = require('pg');
    const sslConfig = process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false;
    const setupClient = new Client({ host: pgHost, port: parseInt(pgPort), user: pgUser, password: pgPass, database: 'postgres', ssl: sslConfig });
    try {
      await setupClient.connect();
      const exists = await setupClient.query("SELECT 1 FROM pg_database WHERE datname = 'bamboo_launcher'");
      if (exists.rows.length === 0) {
        await setupClient.query('CREATE DATABASE bamboo_launcher');
        console.log('[admin] Database "bamboo_launcher" created');
      }
    } catch (e) {
      console.warn('[admin] Could not auto-create database:', e.message);
    } finally {
      await setupClient.end().catch(() => {});
    }
    // === Admin Users ===
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), username VARCHAR(64) UNIQUE NOT NULL, display_name VARCHAR(128) NOT NULL DEFAULT '', password_hash VARCHAR(256) NOT NULL, role VARCHAR(32) NOT NULL DEFAULT 'admin', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_login TIMESTAMPTZ);`);

    // === News ===
    await pool.query(`CREATE TABLE IF NOT EXISTS news (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title VARCHAR(256) NOT NULL, subtitle VARCHAR(512) DEFAULT '', content TEXT NOT NULL DEFAULT '', banner_url VARCHAR(1024) DEFAULT '', category VARCHAR(64) NOT NULL DEFAULT 'general', author VARCHAR(128) NOT NULL DEFAULT 'Bamboo Team', published_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), is_visible BOOLEAN NOT NULL DEFAULT true, is_pinned BOOLEAN NOT NULL DEFAULT false, game_version VARCHAR(32) DEFAULT '', tags TEXT[] DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_news_category ON news(category);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_news_pinned ON news(is_pinned);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_news_visible ON news(is_visible);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at DESC);`);

    // === Events ===
    await pool.query(`CREATE TABLE IF NOT EXISTS events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title VARCHAR(256) NOT NULL, subtitle VARCHAR(512) DEFAULT '', description TEXT NOT NULL DEFAULT '', banner_url VARCHAR(1024) DEFAULT '', category VARCHAR(64) NOT NULL DEFAULT 'general', start_date TIMESTAMPTZ NOT NULL DEFAULT NOW(), end_date TIMESTAMPTZ, is_active BOOLEAN NOT NULL DEFAULT true, is_visible BOOLEAN NOT NULL DEFAULT true, priority INTEGER NOT NULL DEFAULT 0, author VARCHAR(128) NOT NULL DEFAULT 'Bamboo Team', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_active ON events(is_active);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_visible ON events(is_visible);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_dates ON events(start_date, end_date);`);

    // === Banners ===
    await pool.query(`CREATE TABLE IF NOT EXISTS banners (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title VARCHAR(256) NOT NULL, image_url VARCHAR(1024) NOT NULL DEFAULT '', description VARCHAR(512) DEFAULT '', click_target VARCHAR(1024) DEFAULT '', click_type VARCHAR(32) NOT NULL DEFAULT 'external', sort_order INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT true, start_date TIMESTAMPTZ, end_date TIMESTAMPTZ, priority INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_banners_active ON banners(is_active);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_banners_order ON banners(sort_order);`);

    // === Cosmetics ===
    await pool.query(`CREATE TABLE IF NOT EXISTS cosmetics (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug VARCHAR(64) UNIQUE NOT NULL, name VARCHAR(128) NOT NULL, description TEXT NOT NULL DEFAULT '', type VARCHAR(32) NOT NULL DEFAULT 'cape' CHECK(type IN ('cape','aura','hat','ear','rank','other')), rarity VARCHAR(32) NOT NULL DEFAULT 'common' CHECK(rarity IN ('common','rare','epic','legendary','mythic')), preview_url VARCHAR(1024) DEFAULT '', image_url VARCHAR(1024) DEFAULT '', model_url VARCHAR(1024) DEFAULT '', accent_color VARCHAR(32) DEFAULT '', is_active BOOLEAN NOT NULL DEFAULT true, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    // Schema migration: add columns that may be missing from older table versions
    // (CREATE TABLE IF NOT EXISTS does NOT alter existing tables)
    const cosmeticMigrations = [
      `ALTER TABLE cosmetics ADD COLUMN IF NOT EXISTS type VARCHAR(32) NOT NULL DEFAULT 'cape'`,
      `ALTER TABLE cosmetics ADD COLUMN IF NOT EXISTS rarity VARCHAR(32) NOT NULL DEFAULT 'common'`,
      `ALTER TABLE cosmetics ADD COLUMN IF NOT EXISTS preview_url VARCHAR(1024) DEFAULT ''`,
      `ALTER TABLE cosmetics ADD COLUMN IF NOT EXISTS image_url VARCHAR(1024) DEFAULT ''`,
      `ALTER TABLE cosmetics ADD COLUMN IF NOT EXISTS model_url VARCHAR(1024) DEFAULT ''`,
      `ALTER TABLE cosmetics ADD COLUMN IF NOT EXISTS accent_color VARCHAR(32) DEFAULT ''`,
      `ALTER TABLE cosmetics ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`,
      `ALTER TABLE cosmetics ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`,
    ];
    for (const migration of cosmeticMigrations) {
      try { await pool.query(migration); } catch (e) { console.warn('[admin] Migration skipped (cosmetics):', e.message); }
    }
    // Create indexes safely — wrap in try/catch in case column still missing
    for (const idx of [
      { name: 'idx_cosmetics_type', col: 'type' },
      { name: 'idx_cosmetics_rarity', col: 'rarity' },
      { name: 'idx_cosmetics_active', col: 'is_active' },
    ]) {
      try { await pool.query(`CREATE INDEX IF NOT EXISTS ${idx.name} ON cosmetics(${idx.col})`); }
      catch (e) { console.warn(`[admin] Index ${idx.name} konnte nicht erstellt werden:`, e.message); }
    }

    // === Content Types (Bamboo Cloud) ===
    await pool.query(`CREATE TABLE IF NOT EXISTS content_types (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug VARCHAR(64) UNIQUE NOT NULL, name VARCHAR(128) NOT NULL, description TEXT NOT NULL DEFAULT '', current_version INTEGER NOT NULL DEFAULT 1, is_active BOOLEAN NOT NULL DEFAULT true, file_pattern VARCHAR(256) DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    // Schema migration for content_types
    try { await pool.query(`ALTER TABLE content_types ADD COLUMN IF NOT EXISTS file_pattern VARCHAR(256) DEFAULT ''`); } catch {}
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_content_types_slug ON content_types(slug);`);

    // === Content Manifests (file-level) ===
    await pool.query(`CREATE TABLE IF NOT EXISTS content_manifests (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), content_type_id UUID NOT NULL REFERENCES content_types(id) ON DELETE CASCADE, file_path VARCHAR(512) NOT NULL, file_hash VARCHAR(64) NOT NULL, file_size BIGINT NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, mime_type VARCHAR(128) DEFAULT 'application/octet-stream', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(content_type_id, file_path));`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_content_manifests_type ON content_manifests(content_type_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_content_manifests_version ON content_manifests(version);`);

    // === Assets (Unified Content Management) ===
    // This is the SINGLE source of truth for ALL content types:
    // cosmetics, themes, backgrounds, icons, ui_assets, music, shaders,
    // resource_packs, fonts, news, events, banners, and more.
    await pool.query(`CREATE TABLE IF NOT EXISTS assets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug VARCHAR(128) UNIQUE NOT NULL, name VARCHAR(256) NOT NULL, description TEXT NOT NULL DEFAULT '', asset_type VARCHAR(64) NOT NULL DEFAULT 'cosmetic', category VARCHAR(64) NOT NULL DEFAULT 'general', status VARCHAR(32) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')), version INTEGER NOT NULL DEFAULT 1, tags TEXT[] DEFAULT '{}', thumbnail_url VARCHAR(1024) DEFAULT '', preview_url VARCHAR(1024) DEFAULT '', metadata JSONB DEFAULT '{}'::jsonb, is_active BOOLEAN NOT NULL DEFAULT true, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    // Allow any asset_type (removed CHECK constraint for flexibility — validated at API layer)
    try { await pool.query(`ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_asset_type_check`); } catch {}
    try { await pool.query(`ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_asset_type_check1`); } catch {}
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_assets_category ON assets(category);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_assets_slug ON assets(slug);`);

    // === Asset Files (files belonging to an asset) ===
    await pool.query(`CREATE TABLE IF NOT EXISTS asset_files (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE, file_path VARCHAR(512) NOT NULL, file_name VARCHAR(256) NOT NULL, file_type VARCHAR(64) NOT NULL DEFAULT 'other' CHECK(file_type IN ('texture','model','icon','preview','manifest','audio','shader','font','config','other')), file_hash VARCHAR(64) NOT NULL DEFAULT '', file_size BIGINT NOT NULL DEFAULT 0, mime_type VARCHAR(128) DEFAULT 'application/octet-stream', disk_path VARCHAR(1024) DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(asset_id, file_name));`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_asset_files_asset ON asset_files(asset_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_asset_files_type ON asset_files(file_type);`);

    // === Default admin user
    const result = await pool.query('SELECT COUNT(*) FROM admin_users');
    if (parseInt(result.rows[0].count) === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      await pool.query('INSERT INTO admin_users (username, display_name, password_hash, role) VALUES ($1, $2, $3, $4)', ['admin', 'Administrator', hash, 'admin']);
      console.log('[admin] Default admin user created (admin / admin123)');
    }

    // Seed default content types if empty
    const ctCount = await pool.query('SELECT COUNT(*) FROM content_types');
    if (parseInt(ctCount.rows[0].count) === 0) {
      const defaultTypes = [
        ['cosmetics', 'Cosmetics', 'Cosmetic items (capes, auras, hats, etc.)', 'cosmetics/', '*.png,*.glb,*.json'],
        ['news', 'News & Announcements', 'News banners and assets', 'news/', '*.png,*.jpg,*.webp'],
        ['banners', 'Banners', 'Promotional banner images', 'banners/', '*.png,*.jpg,*.webp'],
        ['events', 'Events', 'Event-related images and assets', 'events/', '*.png,*.jpg,*.webp'],
        ['themes', 'Themes', 'Launcher theme assets', 'themes/', '*.png,*.json'],

      ];
      for (const [slug, name, desc, pattern] of defaultTypes) {
        await pool.query('INSERT INTO content_types (slug, name, description, file_pattern) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING', [slug, name, desc, pattern]);
      }
      console.log('[admin] Default content types seeded');
    }

    // Seed default assets if empty (sample demo assets)
    const assetCount = await pool.query('SELECT COUNT(*) FROM assets');
    // Built-in themes removed — all themes come from the admin panel only.
    
    // Cleanup: Delete old built-in theme rows from prior seed runs (if any still exist)
    // This only affects rows with the 8 legacy slugs and asset_type = 'theme'.
    // Custom admin themes are NOT affected.
    try {
      const cleanupResult = await pool.query(
        "DELETE FROM assets WHERE slug = ANY($1::text[]) AND asset_type = 'theme'",
        [['bamboo', 'cherry', 'frozen', 'nether', 'end', 'warden', 'copper', 'obsidian']]
      );
      if (cleanupResult.rowCount > 0) {
        console.log(`[admin] Removed ${cleanupResult.rowCount} legacy built-in theme(s) from database`);
      }
    } catch (e) {
      console.warn('[admin] Built-in theme cleanup skipped:', e.message);
    }
    
    if (parseInt(assetCount.rows[0].count) === 0) {
      const defaultAssets = [
        ['duck-crown', 'Duck Crown', 'A majestic crown for your duck character', 'cosmetic', 'hats', 'published', 1, '{crown,royal,gold}'],
        ['dragon-wings', 'Dragon Wings', 'Epic dragon wings cosmetic', 'cosmetic', 'wings', 'draft', 1, '{wings,dragon,epic}'],
        ['welcome-update', 'Willkommen bei Bamboo!', 'Bamboo Launcher v0.1 ist da - neuer Mod-Browser und Discord RPC', 'news', 'update', 'published', 1, '{news,update,welcome}', '{"content":"Bamboo Launcher v0.1 ist da!","author":"Bamboo Team"}'],
        ['summer-event-2026', 'Sommer-Event 2026', 'Feiere den Sommer mit exklusiven Cosmetics!', 'event', 'seasonal', 'published', 1, '{event,summer,seasonal}', '{"startDate":"2026-06-01T00:00:00Z","endDate":"2026-08-31T23:59:59Z","rewards":"Exklusive Sommer-Cosmetics"}'],
      ];
      for (const [slug, name, desc, type, cat, status, ver, tags, metadata] of defaultAssets) {
        await pool.query(
          'INSERT INTO assets (slug, name, description, asset_type, category, status, version, tags, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, category=EXCLUDED.category, metadata=EXCLUDED.metadata, updated_at=NOW()',
          [slug, name, desc, type, cat, status, ver, tags, metadata]
        );
      }
      console.log('[admin] Default sample assets seeded');
    }

    // === Migrate deprecated 'background' asset_type to 'theme' ===
    try {
      const bgResult = await pool.query(
        "UPDATE assets SET asset_type = 'theme', updated_at = NOW() WHERE asset_type = 'background'"
      );
      if (bgResult.rowCount > 0) {
        console.log(`[admin] Migrated ${bgResult.rowCount} background(s) to theme type`);
      }
    } catch (e) {
      console.warn('[admin] Background migration skipped:', e.message);
    }


    dbState.connected = true;
    console.log('[admin] PostgreSQL connected, all tables initialized');
  } catch (err) {
    console.error('[admin] PostgreSQL initialization FAILED:', err.message);
    console.error('[admin] Server cannot start without PostgreSQL. Please check your database configuration.');
    process.exit(1);
  }
}


// ===== Content root directory (where files are served from) =====
const CONTENT_ROOT = process.env.BAMBOO_CONTENT_DIR || path.join(__dirname, '..', 'content');

// ===== Bamboo Content Repo (GitHub CDN) =====
// On Render (Linux): defaults to /tmp/bamboo-content
// On local Windows: defaults to C:\BambooContent
const BAMBOO_CONTENT_REPO = process.env.BAMBOO_CONTENT_REPO || (
  process.env.NODE_ENV === 'production'
    ? '/tmp/bamboo-content'
    : path.resolve(__dirname, '..', '..', '..', 'BambooContent')
);

// Launcher root: on Render, scripts won't be available. On local, they're in the parent dir.
const LAUNCHER_ROOT = process.env.NODE_ENV === 'production'
  ? __dirname
  : path.resolve(__dirname, '..', '..', '..');
const MANIFEST_SCRIPT = path.join(LAUNCHER_ROOT, 'scripts', 'generate-manifest.mjs');

// Ensure content repo directory exists (create it if needed)
function ensureContentRepoDir() {
  if (!fs.existsSync(BAMBOO_CONTENT_REPO)) {
    try {
      fs.mkdirSync(BAMBOO_CONTENT_REPO, { recursive: true });
      console.log('[admin] Created content repo dir:', BAMBOO_CONTENT_REPO);
    } catch (err) {
      console.warn('[admin] Could not create content repo dir:', err.message);
    }
  }
}

// ===== Inline Manifest Generator (fallback when script is unavailable) =====
function walkDirAndHash(dir, baseDir, excludePatterns = []) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    
    // Skip excluded
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'manifest.json' ||
        entry.name.endsWith('.md') || entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
    
    if (entry.isDirectory()) {
      results.push(...walkDirAndHash(fullPath, baseDir, excludePatterns));
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        const fileData = fs.readFileSync(fullPath);
        const hash = crypto.createHash('sha256').update(fileData).digest('hex');
        results.push({ path: relativePath, hash, size: stat.size });
      } catch (e) {
        console.warn(`[admin] Could not hash ${relativePath}:`, e.message);
      }
    }
  }
  return results;
}

function generateManifestInline(dryRun = false) {
  ensureContentRepoDir();
  
  const files = walkDirAndHash(BAMBOO_CONTENT_REPO, BAMBOO_CONTENT_REPO);
  files.sort((a, b) => a.path.localeCompare(b.path));
  
  // Determine version
  let version = 1;
  const manifestPath = path.join(BAMBOO_CONTENT_REPO, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const oldFiles = new Map(existing.files.map(f => [f.path, f.hash]));
      const newFiles = new Map(files.map(f => [f.path, f.hash]));
      let hasChanges = oldFiles.size !== newFiles.size;
      if (!hasChanges) {
        for (const [p, h] of newFiles) {
          if (oldFiles.get(p) !== h) { hasChanges = true; break; }
        }
      }
      version = hasChanges ? (existing.version || 0) + 1 : (existing.version || 1);
    } catch { /* invalid manifest, start fresh */ }
  }
  
  const manifest = {
    schemaVersion: 1,
    version,
    updatedAt: new Date().toISOString(),
    files,
  };
  
  if (!dryRun) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    console.log(`[admin] Manifest v${version} generated with ${files.length} files`);
  }
  
  return { manifest, output: `Generated v${version} with ${files.length} files`, dryRun };
}

// ===== Express App =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ===== Multer for file uploads =====
const multer = require('multer');

// Allowed file extensions for content repo uploads
const ALLOWED_EXTS = ['.png','.jpg','.jpeg','.webp','.gif','.svg','.glb','.gltf','.json','.mp3','.ogg','.wav','.ttf','.otf','.woff2','.zip','.ico','.bbmodel','.bin','.css','.js','.lottie','.mp4'];

const contentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // Determine subdirectory from category field
      // Note: multer processes text fields alongside files, so req.body is available
      // if the category field comes before the file in the form.
      const category = (req.body && req.body.category) || 'assets';
      // Sanitize: allow alphanumeric, dash, underscore, space, hyphen
      const safeCategory = category.replace(/[^a-zA-Z0-9_ \-]/g, '').trim();
      const destDir = path.join(BAMBOO_CONTENT_REPO, safeCategory);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      cb(null, destDir);
    },
    filename: (req, file, cb) => {
      // Sanitize filename - preserve spaces, dashes, dots, underscores
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._\- ]/g, '_');
      cb(null, safeName);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      const err = new Error(`File type "${ext}" not allowed. Allowed: ${ALLOWED_EXTS.join(', ')}`);
      err.status = 400;
      return cb(err, false);
    }
    cb(null, true);
  },
});

// ===== Auth Middleware =====
function authenticateAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    req.admin = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch { return res.status(401).json({ success: false, error: 'Invalid token' }); }
}

// ===== Auth =====
app.put('/api/admin/content/cosmetic/:id/unlock', authenticateAdmin, async (req, res) => {
  try {
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const itemId = req.params.id;
    const incoming = req.body || {};
    const unlock = incoming.unlock || { type: 'free', requirements: [] };
    const treeNodeId = incoming.treeNodeId || unlock.treeNodeId || null;
    const lockVisibility = incoming.lockVisibility || null;

    const r = await pool.query('SELECT metadata FROM assets WHERE id = $1 AND asset_type = $2', [itemId, 'cosmetic']);
    if (!r.rows.length) return res.status(404).json({ error: 'Cosmetic not found' });
    const meta = r.rows[0].metadata || {};
    meta.unlock = unlock;
    meta.unlockType = unlock.type || 'free';
    meta.unlockRequirements = unlock.requirements || [];
    if (treeNodeId) meta.treeNodeId = treeNodeId;
    if (lockVisibility) meta.lockVisibility = lockVisibility;
    await pool.query('UPDATE assets SET metadata = $1::jsonb, version = version + 1, updated_at = NOW() WHERE id = $2', [JSON.stringify(meta), itemId]);
    return res.json({ success: true, unlock, treeNodeId, lockVisibility });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: 'Username and password required' });
  try {
    if (!dbState.connected) return res.status(503).json({ success: false, error: 'Database not available' });
    const r = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
    if (r.rows.length === 0) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    const u = r.rows[0];
    if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    await pool.query('UPDATE admin_users SET last_login = NOW() WHERE id = $1', [u.id]);
    const token = jwt.sign({ id: u.id, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ success: true, data: { token, user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role }, permissions: ['news.read','news.write','news.delete','events.read','events.write','events.delete','banners.read','banners.write','banners.delete','cosmetics.read','cosmetics.write','cosmetics.delete','content.publish'] } });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/auth/verify', authenticateAdmin, (req, res) => {
  res.json({ success: true, data: { id: req.admin.id, username: req.admin.username, role: req.admin.role, permissions: ['news.read','news.write','news.delete','events.read','events.write','events.delete','banners.read','banners.write','banners.delete','cosmetics.read','cosmetics.write','cosmetics.delete','content.publish'] } });
});

app.get('/api/health', async (req, res) => {
  if (!dbState.connected) return res.status(503).json({ status: 'error', database: 'disconnected', backendVersion: '0.1.0' });
  let dbStatus = 'disconnected';
  try { await pool.query('SELECT 1'); dbStatus = 'connected'; } catch {}
  res.json({ status: 'ok', database: dbStatus, backendVersion: '0.1.0' });
});

// ===== Multer Error Handler Middleware =====
function handleMulterErrors(err, req, res, next) {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_UNEXPECTED_FILE' || err.status === 400)) {
    return res.status(400).json({ error: err.message || 'File upload rejected' });
  }
  next(err);
}

// ===== SANITIZE HELPERS =====
function sanitizeHtml(text) {
  return (text || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/on\w+="[^"]*"/gi, '');
}

// ======================================================================
// Legacy API endpoints were removed in favor of the UNIFIED CONTENT MANAGER.
// See contentRoutes.js for the replacement.
// ======================================================================

// ======================================================================
// === CONTENT DISTRIBUTION API (Bamboo Cloud) =========================
// ======================================================================
function mapEventRow(r) { return { id: r.id, title: r.title, subtitle: r.subtitle || '', description: r.description || '', bannerUrl: r.banner_url || '', category: r.category || 'general', startDate: r.start_date ? new Date(r.start_date).toISOString() : new Date().toISOString(), endDate: r.end_date ? new Date(r.end_date).toISOString() : null, isActive: r.is_active !== undefined ? r.is_active : true, isVisible: r.is_visible !== undefined ? r.is_visible : true, priority: r.priority || 0, author: r.author || 'Bamboo Team', createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(), updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString() }; }

app.get('/api/events', async (req, res) => {
  try {
    const { category, search, active, visible, page = 1, limit = 20 } = req.query;
    const off = (parseInt(page)-1)*parseInt(limit);
    const now = new Date();
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    let q = 'SELECT * FROM events WHERE 1=1'; const p = []; let i = 1;
    if (active==='true') { q += ' AND is_active=true AND start_date <= NOW() AND (end_date IS NULL OR end_date >= NOW())'; }
    else if (active==='false') { q += ' AND (is_active=false OR start_date > NOW() OR (end_date IS NOT NULL AND end_date < NOW()))'; }
    if (visible==='true') q += ' AND is_visible=true'; else if (visible==='false') q += ' AND is_visible=false';
    if (category && category!=='all') { q += ` AND category=$${i++}`; p.push(category); }
    if (search) { q += ` AND (title ILIKE $${i} OR subtitle ILIKE $${i} OR description ILIKE $${i})`; p.push(`%${search}%`); i++; }
    q += ' ORDER BY is_active DESC, priority DESC, start_date ASC';
    const cq = q.split('ORDER BY')[0].replace('SELECT *','SELECT COUNT(*)');
    q += ` LIMIT $${i++} OFFSET $${i++}`; p.push(parseInt(limit), off);
    const [r, cr] = await Promise.all([pool.query(q,p), pool.query(cq, p.slice(0,-2))]);
    return res.json({ data: r.rows.map(mapEventRow), total: parseInt(cr.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/events/:id', async (req, res) => {
  try {
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query('SELECT * FROM events WHERE id=$1',[req.params.id]); if(!r.rows.length) return res.status(404).json({error:'Event not found'}); return res.json(mapEventRow(r.rows[0]));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/api/events', authenticateAdmin, async (req, res) => {
  try {
    const { title, subtitle, description, bannerUrl, category, startDate, endDate, isActive, isVisible, priority, author } = req.body;
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'Title required' });
    if (title.length > 256) return res.status(400).json({ error: 'Title too long' });
    const id = uuidv4();
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query(`INSERT INTO events (id,title,subtitle,description,banner_url,category,start_date,end_date,is_active,is_visible,priority,author) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id,title,subtitle||'',description||'',bannerUrl||'',category||'general',startDate?new Date(startDate):new Date(),endDate?new Date(endDate):null,isActive!==false,isVisible!==false,priority||0,author||'Bamboo Team']);
    return res.status(201).json(mapEventRow(r.rows[0]));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.put('/api/events/:id', authenticateAdmin, async (req, res) => {
  try {
    const { title, subtitle, description, bannerUrl, category, startDate, endDate, isActive, isVisible, priority, author } = req.body;
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const ex = await pool.query('SELECT * FROM events WHERE id=$1',[req.params.id]); if(!ex.rows.length) return res.status(404).json({error:'Event not found'});
    const r = await pool.query(`UPDATE events SET title=COALESCE($2,title),subtitle=COALESCE($3,subtitle),description=COALESCE($4,description),banner_url=COALESCE($5,banner_url),category=COALESCE($6,category),start_date=COALESCE($7,start_date),end_date=COALESCE($8,end_date),is_active=COALESCE($9,is_active),is_visible=COALESCE($10,is_visible),priority=COALESCE($11,priority),author=COALESCE($12,author),updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id,title,subtitle,description,bannerUrl,category,startDate?new Date(startDate):null,endDate!==undefined?(endDate?new Date(endDate):null):undefined,isActive!==undefined?isActive:null,isVisible!==undefined?isVisible:null,priority,author]);
    return res.json(mapEventRow(r.rows[0]));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.delete('/api/events/:id', authenticateAdmin, async (req, res) => {
  try {
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query('DELETE FROM events WHERE id=$1 RETURNING id',[req.params.id]); if(!r.rows.length) return res.status(404).json({error:'Event not found'}); return res.json({success:true});
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.patch('/api/events/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query('UPDATE events SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id]); if(!r.rows.length) return res.status(404).json({error:'Event not found'}); return res.json(mapEventRow(r.rows[0]));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ======================================================================

// ======================================================================
// === CONTENT DISTRIBUTION API (Bamboo Cloud) ==========================
// ======================================================================

// Helper: compute SHA-256 hash of a file (uses crypto from top-level require)
function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    const hash = crypto.createHash('sha256');
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Helper: map content type row to camelCase
function mapContentTypeRow(r) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description || '',
    currentVersion: r.current_version,
    isActive: r.is_active,
    filePattern: r.file_pattern || '',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
  };
}

// Helper: map content manifest row to camelCase
function mapManifestRow(r) {
  return {
    id: r.id,
    contentTypeId: r.content_type_id,
    filePath: r.file_path,
    fileHash: r.file_hash,
    fileSize: r.file_size,
    version: r.version,
    mimeType: r.mime_type || 'application/octet-stream',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------
// GET /api/content/types — List all content types
// ---------------------------------------------------------------
app.get('/api/content/types', async (req, res) => {
  try {
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query('SELECT * FROM content_types WHERE is_active = true ORDER BY slug');
    return res.json({ data: r.rows.map(mapContentTypeRow) });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// GET /api/content/manifest — Full manifest with versions & hashes
// ---------------------------------------------------------------
app.get('/api/content/manifest', async (req, res) => {
  try {
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const types = await pool.query('SELECT * FROM content_types WHERE is_active = true ORDER BY slug');
    const manifest = [];
    for (const ct of types.rows) {
      const files = await pool.query(
        'SELECT * FROM content_manifests WHERE content_type_id = $1 ORDER BY file_path',
        [ct.id]
      );
      manifest.push({
        type: mapContentTypeRow(ct),
        files: files.rows.map(mapManifestRow),
      });
    }
    return res.json({ data: manifest });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// POST /api/content/check — Compare client versions with server
//   Body: { versions: { "cosmetics": 2, "news": 1, ... } }
//   Returns: { updates: [{ typeSlug, currentVersion, files: [...] }] }
// ---------------------------------------------------------------
app.post('/api/content/check', async (req, res) => {
  try {
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const clientVersions = req.body.versions || {};
    const updates = [];
    const types = await pool.query('SELECT * FROM content_types WHERE is_active = true');
    for (const ct of types.rows) {
      const clientVer = clientVersions[ct.slug] || 0;
      if (ct.current_version > clientVer) {
        // Get only changed/added files since client version
        const files = await pool.query(
          'SELECT * FROM content_manifests WHERE content_type_id = $1 AND version > $2 ORDER BY file_path',
          [ct.id, clientVer]
        );
        updates.push({
          typeSlug: ct.slug,
          currentVersion: ct.current_version,
          files: files.rows.map(mapManifestRow),
        });
      }
    }
    return res.json({
      updates,
      upToDate: updates.length === 0,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// GET /api/content/files/:type — List files for a content type
// ---------------------------------------------------------------
app.get('/api/content/files/:type', async (req, res) => {
  try {
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const typeSlug = req.params.type;
    const ct = await pool.query('SELECT * FROM content_types WHERE slug = $1 AND is_active = true', [typeSlug]);
    if (!ct.rows.length) return res.status(404).json({ error: 'Content type not found' });
    const files = await pool.query(
      'SELECT * FROM content_manifests WHERE content_type_id = $1 ORDER BY file_path',
      [ct.rows[0].id]
    );
    return res.json({ type: mapContentTypeRow(ct.rows[0]), files: files.rows.map(mapManifestRow) });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// GET /api/content/download/:type/* — Download a content file
// ---------------------------------------------------------------
app.get('/api/content/download/:type/*', async (req, res) => {
  try {
    const typeSlug = req.params.type;
    const filePath = req.params[0];
    if (!filePath) return res.status(400).json({ error: 'File path required' });

    // Validate path (prevent directory traversal)
    const normalizedPath = path.normalize(filePath).replace(/^(\\\\\?\\)?/, '');
    if (normalizedPath.includes('..')) {
      return res.status(403).json({ error: 'Invalid file path' });
    }

    const fullPath = path.join(CONTENT_ROOT, typeSlug, normalizedPath);

    // Security: ensure file is within content root
    const resolvedRoot = path.resolve(CONTENT_ROOT);
    const resolvedFile = path.resolve(fullPath);
    if (!resolvedFile.startsWith(resolvedRoot + path.sep) && resolvedFile !== resolvedRoot) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a file' });
    }

    const mimeType = getMimeType(filePath);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Hash', await computeFileHash(fullPath));

    const stream = fs.createReadStream(fullPath);
    stream.pipe(res);
    stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// POST /api/content/publish — Admin: Bump version & register files
//   Body: { typeSlug, version: 3, files: [{ path, hash, size, mimeType }] }
// ---------------------------------------------------------------
app.post('/api/content/publish', authenticateAdmin, async (req, res) => {
  try {
    const { typeSlug, version, files } = req.body;
    if (!typeSlug || !version || !Array.isArray(files)) {
      return res.status(400).json({ error: 'typeSlug, version, and files array required' });
    }

    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const ct = await pool.query('SELECT * FROM content_types WHERE slug = $1', [typeSlug]);
    if (!ct.rows.length) return res.status(404).json({ error: 'Content type not found' });

    const ctId = ct.rows[0].id;

    // Update content type version
    await pool.query('UPDATE content_types SET current_version = $1, updated_at = NOW() WHERE id = $2', [version, ctId]);

    // Upsert files into manifest
    for (const file of files) {
      await pool.query(`
        INSERT INTO content_manifests (content_type_id, file_path, file_hash, file_size, version, mime_type)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (content_type_id, file_path)
        DO UPDATE SET file_hash = $3, file_size = $4, version = $5, mime_type = $6, updated_at = NOW()
      `, [ctId, file.path, file.hash, file.size || 0, version, file.mimeType || 'application/octet-stream']);
    }

    return res.json({ success: true, typeSlug, version });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// GET /api/content/status — Quick sync status overview
// ---------------------------------------------------------------
app.get('/api/content/status', async (req, res) => {
  try {
    if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
    const types = await pool.query('SELECT slug, name, current_version, updated_at FROM content_types WHERE is_active = true ORDER BY slug');
    const totalFiles = await pool.query('SELECT COUNT(*) as count FROM content_manifests');
    const totalSize = await pool.query('SELECT COALESCE(SUM(file_size), 0) as total FROM content_manifests');
    return res.json({
      status: 'ok',
      types: types.rows.map(t => ({ slug: t.slug, name: t.name, version: t.current_version, updatedAt: t.updated_at ? new Date(t.updated_at).toISOString() : null })),
      totalFiles: parseInt(totalFiles.rows[0].count),
      totalSize: parseInt(totalSize.rows[0].total),
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// MIME type helper
// ---------------------------------------------------------------
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.bin': 'application/octet-stream',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.zip': 'application/zip',
    '.lottie': 'application/json',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

// ======================================================================
// === CONTENT REPO MANAGEMENT API (Phase 1+2 Admin) =====================
// ======================================================================

const { exec, execFileSync, execFile } = require('child_process');

// ---------------------------------------------------------------
// POST /api/content/upload — Upload a file to the content repo
//   Form fields: file (file), category (string)
// ---------------------------------------------------------------
app.post('/api/content/upload', authenticateAdmin, contentUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const relativePath = path.relative(BAMBOO_CONTENT_REPO, req.file.path).replace(/\\/g, '/');
    return res.json({
      success: true,
      file: {
        originalName: req.file.originalname,
        storedPath: relativePath,
        size: req.file.size,
        fullPath: req.file.path,
      },
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// POST /api/content/upload-multiple — Upload multiple files
//   Form fields: files (multiple), category (string)
// ---------------------------------------------------------------
app.post('/api/content/upload-multiple', authenticateAdmin, contentUpload.array('files', 20), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const uploaded = req.files.map(f => ({
      originalName: f.originalname,
      storedPath: path.relative(BAMBOO_CONTENT_REPO, f.path).replace(/\\/g, '/'),
      size: f.size,
      fullPath: f.path,
    }));

    return res.json({ success: true, files: uploaded, count: uploaded.length });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// POST /api/content/generate-manifest — Regenerate manifest.json
//   Runs the manifest generator (inline or via script)
// ---------------------------------------------------------------
app.post('/api/content/generate-manifest', authenticateAdmin, (req, res) => {
  try {
    const dryRun = req.body && req.body.dryRun === true;

    // Try using the external script first (local dev), fall back to inline
    if (fs.existsSync(MANIFEST_SCRIPT)) {
      const args = dryRun ? ['--dry-run'] : [];
      execFile('node', [MANIFEST_SCRIPT, ...args], {
        cwd: LAUNCHER_ROOT, timeout: 30000, encoding: 'utf-8'
      }, (error, stdout, stderr) => {
        if (error) {
          // Fall back to inline generation on script error
          console.warn('[admin] Script failed, using inline manifest generator');
          try {
            const result = generateManifestInline(dryRun);
            return res.json({
              success: true,
              dryRun,
              output: result.output,
              manifest: dryRun ? null : result.manifest,
              generator: 'inline (script failed)',
            });
          } catch (e) {
            return res.status(500).json({ error: 'Manifest generation failed', details: e.message });
          }
        }

        const manifestPath = path.join(BAMBOO_CONTENT_REPO, 'manifest.json');
        let manifest = null;
        if (!dryRun && fs.existsSync(manifestPath)) {
          try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch {}
        }

        return res.json({
          success: true,
          dryRun,
          output: (stdout || '').trim(),
          manifest,
          generator: 'script',
        });
      });
    } else {
      // No script available (Render) — use inline generator
      const result = generateManifestInline(dryRun);
      return res.json({
        success: true,
        dryRun,
        output: result.output,
        manifest: dryRun ? null : result.manifest,
        generator: 'inline',
      });
    }
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// GET /api/content/repo-status — Content repo status & manifest info
// ---------------------------------------------------------------
app.get('/api/content/repo-status', authenticateAdmin, (req, res) => {
  try {
    const result = {
      repoPath: BAMBOO_CONTENT_REPO,
      repoExists: fs.existsSync(BAMBOO_CONTENT_REPO),
      manifest: null,
      directoryTree: {},
      git: null,
    };

    // Read manifest
    const manifestPath = path.join(BAMBOO_CONTENT_REPO, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        result.manifest = {
          schemaVersion: raw.schemaVersion,
          version: raw.version,
          updatedAt: raw.updatedAt,
          fileCount: raw.files ? raw.files.length : 0,
          totalSize: raw.files ? raw.files.reduce((sum, f) => sum + (f.size || 0), 0) : 0,
        };
      } catch { result.manifest = { error: 'Invalid manifest.json' }; }
    }

    // Build directory tree (top-level categories)
    if (fs.existsSync(BAMBOO_CONTENT_REPO)) {
      try {
        const entries = fs.readdirSync(BAMBOO_CONTENT_REPO, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === '.git' || entry.name === 'manifest.json' || entry.name.endsWith('.md')) continue;

          if (entry.isDirectory()) {
            const subEntries = fs.readdirSync(path.join(BAMBOO_CONTENT_REPO, entry.name), { withFileTypes: true });
            const fileCount = subEntries.filter(e => e.isFile()).length;
            const dirCount = subEntries.filter(e => e.isDirectory()).length;
            result.directoryTree[entry.name] = { type: 'directory', files: fileCount, subdirs: dirCount };
          } else {
            result.directoryTree[entry.name] = { type: 'file', size: fs.statSync(path.join(BAMBOO_CONTENT_REPO, entry.name)).size };
          }
        }
      } catch {}
    }

    // Git info (using execFileSync for safety)
    try {
      // Check if git is available first
      execFileSync('git', ['--version'], { timeout: 3000, encoding: 'utf-8' });
      
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: BAMBOO_CONTENT_REPO, timeout: 5000, encoding: 'utf-8'
      }).trim();
      const lastCommit = execFileSync('git', ['log', '-1', '--format=%h %s (%ci)'], {
        cwd: BAMBOO_CONTENT_REPO, timeout: 5000, encoding: 'utf-8'
      }).trim();
      const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: BAMBOO_CONTENT_REPO, timeout: 5000, encoding: 'utf-8'
      }).trim();
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: BAMBOO_CONTENT_REPO, timeout: 5000, encoding: 'utf-8'
      }).trim();

      result.git = {
        branch,
        remoteUrl,
        lastCommit,
        hasUncommittedChanges: status.length > 0,
        changedFiles: status ? status.split('\n').length : 0,
        status: status || '(clean)',
      };
    } catch {
      result.git = { error: 'Git not available or not a git repository' };
    }

    return res.json({ success: true, data: result });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// POST /api/content/git-push — Commit and push content repo to GitHub
//   Body: { message: "commit message" }
//   Automatically regenerates manifest.json before committing.
// ---------------------------------------------------------------
app.post('/api/content/git-push', authenticateAdmin, (req, res) => {
  try {
    const commitMessage = (req.body && req.body.message) || 'Update content from admin panel';

    if (!fs.existsSync(BAMBOO_CONTENT_REPO)) {
      return res.status(500).json({ error: 'Content repo not found: ' + BAMBOO_CONTENT_REPO });
    }

    const results = [];

    // Step 0: Auto-generate manifest before committing
    try {
      const result = generateManifestInline(false);
      results.push({ step: 'generate-manifest', output: result.output });
    } catch (e) {
      results.push({ step: 'generate-manifest', error: e.message });
    }

    // Check if git is available and we're in a git repo
    let gitAvailable = false;
    try {
      execFileSync('git', ['--version'], { timeout: 3000, encoding: 'utf-8' });
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd: BAMBOO_CONTENT_REPO, timeout: 3000 });
      gitAvailable = true;
    } catch {
      results.push({ step: 'git-check', output: 'Git not available or not a repo (Render/cloud environment)' });
      return res.json({
        success: true,
        message: 'Manifest generated but git push skipped (git not available on this server). Use the desktop admin for git operations.',
        committed: false,
        manifestGenerated: true,
        results,
      });
    }

    // Step 1: git add -A (using execFileSync for safety)
    try {
      const addOutput = execFileSync('git', ['add', '-A'], {
        cwd: BAMBOO_CONTENT_REPO, timeout: 10000, encoding: 'utf-8'
      }).trim();
      results.push({ step: 'git add -A', output: addOutput || '(ok)' });
    } catch (e) {
      results.push({ step: 'git add -A', error: e.message });
      return res.status(500).json({ error: 'Git add failed', results });
    }

    // Step 2: git commit (only if there are changes)
    // Uses execFileSync with args array — no command injection possible
    let commitCreated = false;
    try {
      const statusCheck = execFileSync('git', ['status', '--porcelain'], {
        cwd: BAMBOO_CONTENT_REPO, timeout: 5000, encoding: 'utf-8'
      }).trim();
      if (statusCheck.length > 0) {
        const commitOutput = execFileSync('git', ['commit', '-m', commitMessage], {
          cwd: BAMBOO_CONTENT_REPO, timeout: 10000, encoding: 'utf-8'
        }).trim();
        results.push({ step: 'git commit', output: commitOutput });
        commitCreated = true;
      } else {
        results.push({ step: 'git commit', output: '(nothing to commit)' });
      }
    } catch (e) {
      results.push({ step: 'git commit', error: e.message });
      return res.status(500).json({ error: 'Git commit failed', results });
    }

    // Step 3: git push
    try {
      const pushOutput = execFileSync('git', ['push'], {
        cwd: BAMBOO_CONTENT_REPO, timeout: 30000, encoding: 'utf-8'
      }).trim();
      results.push({ step: 'git push', output: pushOutput });
    } catch (e) {
      results.push({ step: 'git push', error: e.message });
      return res.status(500).json({
        error: 'Git push failed (check credentials/network)',
        results,
        committed: commitCreated,
      });
    }

    return res.json({
      success: true,
      message: commitCreated ? 'Changes committed and pushed (manifest auto-generated)' : 'No changes to push',
      committed: commitCreated,
      results,
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// DELETE /api/content/file — Delete a file from the content repo
//   Body: { path: "cosmetics/my-file.png" }
// ---------------------------------------------------------------
app.delete('/api/content/file', authenticateAdmin, (req, res) => {
  try {
    const filePath = (req.body && req.body.path) || '';
    if (!filePath) return res.status(400).json({ error: 'File path required' });

    // Security: prevent traversal
    const sanitized = filePath.replace(/\\/g, '/').replace(/\.\./g, '');
    const fullPath = path.join(BAMBOO_CONTENT_REPO, sanitized);

    const resolved = path.resolve(fullPath);
    const resolvedRoot = path.resolve(BAMBOO_CONTENT_REPO);
    if (!resolved.startsWith(resolvedRoot)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    fs.unlinkSync(fullPath);
    return res.json({ success: true, deleted: sanitized });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ===== Multer Error Handler (must be after routes that use multer) =====
app.use(handleMulterErrors);

// ===== Asset Management Routes (Phase 3) =====
const assetRoutes = require('./assetRoutes');
assetRoutes(app, { pool, dbState, authenticateAdmin, uuidv4 });

// ===== Unified Content Manager Routes =====
// ===== Unified Content Manager Routes =====
const contentRoutes = require('./contentRoutes');
contentRoutes(app, { pool, dbState, authenticateAdmin, uuidv4, multer });

// ===== Serve Admin Panel UI =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-panel.html'));
});

// Also serve the admin panel for any unmatched /admin* routes
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-panel.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-panel.html'));
});

// ===== Start =====
async function start() {
  await initDatabase();
  
  // Ensure content root directory exists
  if (!fs.existsSync(CONTENT_ROOT)) {
    try {
      fs.mkdirSync(CONTENT_ROOT, { recursive: true });
      console.log(`[admin] Created content root directory: ${CONTENT_ROOT}`);
    } catch (err) {
      console.warn(`[admin] Could not create content root: ${err.message}`);
    }
  }
  
  // Ensure Bamboo Content Repo directory exists
  ensureContentRepoDir();

  app.listen(PORT, () => {
    console.log(`🛡️  Bamboo Admin API running on port ${PORT}`);
    console.log(`   Database: PostgreSQL connected`);
    console.log(`   Content Root: ${CONTENT_ROOT}`);
    console.log(`   Content Repo: ${BAMBOO_CONTENT_REPO}`);
    console.log(`   Endpoints: /api/auth, /api/content/*, /api/health, /api/assets/*`);
  });
}

// Nur automatisch starten wenn direkt ausgeführt (nicht per require geladen)
if (require.main === module) {
  start();
}

module.exports = { app, initDatabase, start, pool, CONTENT_ROOT };
