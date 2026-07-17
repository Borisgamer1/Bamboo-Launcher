// ============================================================
// Bamboo Share v0.1.0
// Profile Import/Export & Code-based Sharing Backend
// ============================================================
// Dieses Modul wird in den Admin-Server (admin.js) eingebunden
// und läuft auf demselben Port (3005).
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ===== Configuration =====
const SHARE_STORAGE_DIR = process.env.BAMBOO_SHARE_DIR || path.join(__dirname, '..', 'share_storage');
const MAX_FILE_SIZE = process.env.BAMBOO_MAX_SHARE_SIZE || 500 * 1024 * 1024; // 500 MB
const SHARE_CODE_LENGTH = 8;
const SHARE_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I,O,0,1 to avoid confusion

const SHARE_EXPIRY_DAYS = 30; // Shares expire after 30 days

// ===== Module State =====
let pool = null;
let dbConnected = false;

// ===== Create share tables if they don't exist =====
async function ensureTables() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS bamboo_shares (
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
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bamboo_shares_code ON bamboo_shares(share_code)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bamboo_shares_active ON bamboo_shares(is_active)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bamboo_shares_created ON bamboo_shares(created_at DESC)`);
    
    await pool.query(`CREATE TABLE IF NOT EXISTS share_downloads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      share_id UUID NOT NULL REFERENCES bamboo_shares(id) ON DELETE CASCADE,
      downloader_ip VARCHAR(45) DEFAULT '',
      downloader_username VARCHAR(128) DEFAULT '',
      user_agent TEXT DEFAULT '',
      downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_share_downloads_share ON share_downloads(share_id)`);
    
    await pool.query(`CREATE TABLE IF NOT EXISTS profile_exports (
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
    )`);
    
    await pool.query(`CREATE TABLE IF NOT EXISTS profile_imports (
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
    )`);
    
    console.log('[share] Tables initialized successfully');
  } catch (err) {
    console.error('[share] Table initialization failed:', err.message);
  }
}

// ===== Initialize =====
function init(dbPool) {
  pool = dbPool;
  dbConnected = true;
  
  // Ensure storage directory exists
  if (!fs.existsSync(SHARE_STORAGE_DIR)) {
    fs.mkdirSync(SHARE_STORAGE_DIR, { recursive: true });
    console.log('[share] Storage directory created:', SHARE_STORAGE_DIR);
  }
  
  // Auto-create tables on init
  ensureTables();
  
  // Clean expired shares on startup
  cleanExpiredShares();
}

// ===== Helpers =====

/** Generate a unique, human-readable share code */
function generateShareCode() {
  let code = '';
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    code += SHARE_CODE_CHARS[crypto.randomInt(0, SHARE_CODE_CHARS.length)];
  }
  return code;
}

/** Compute SHA-256 hash of a file */
function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Get directory size recursively */
function getDirSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      } else {
        const stat = fs.statSync(fullPath);
        total += stat.size;
      }
    }
  } catch { /* ignore */ }
  return total;
}

/** Count files in directory */
function countFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        count += countFiles(fullPath);
      } else {
        count++;
      }
    }
  } catch { /* ignore */ }
  return count;
}

/** Validate that a file path is within the allowed storage directory */
function isPathSafe(targetPath, allowedDir) {
  const resolved = path.resolve(targetPath);
  const allowed = path.resolve(allowedDir);
  return resolved.startsWith(allowed + path.sep) || resolved === allowed;
}

/** Sanitize filename to prevent path traversal */
function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 255);
}

/** Clean expired shares from database and disk */
async function cleanExpiredShares() {
  if (!dbConnected || !pool) return;
  try {
    const result = await pool.query(
      `SELECT id, file_storage_path FROM bamboo_shares 
       WHERE (expires_at IS NOT NULL AND expires_at < NOW()) OR is_active = false`
    );
    
    for (const row of result.rows) {
      // Remove stored file
      if (row.file_storage_path && fs.existsSync(row.file_storage_path)) {
        try {
          fs.unlinkSync(row.file_storage_path);
          console.log('[share] Removed expired share file:', row.file_storage_path);
        } catch (e) {
          console.warn('[share] Could not remove expired file:', e.message);
        }
      }
    }
    
    // Delete from database
    await pool.query(
      `DELETE FROM bamboo_shares WHERE (expires_at IS NOT NULL AND expires_at < NOW()) OR is_active = false`
    );
    
    console.log('[share] Cleaned expired shares');
  } catch (err) {
    console.warn('[share] Cleanup error:', err.message);
  }
}

// ===== Router =====
const router = express.Router();

// Middleware to check DB
router.use((req, res, next) => {
  if (!dbConnected) {
    return res.status(503).json({ success: false, error: 'Database not available' });
  }
  next();
});

// ============================================================
// CREATE SHARE
// POST /api/share/create
// ============================================================
router.post('/create', async (req, res) => {
  try {
    const {
      title,
      description,
      minecraftVersion,
      modloader,
      modloaderVersion,
      fileData, // Base64-encoded file data, or a file path for local storage
      fileName,
      modCount,
      resourcepackCount,
      shaderCount,
      datapackCount,
      worldCount,
      authorName,
      authorId,
    } = req.body;

    if (!title || !minecraftVersion || !fileData) {
      return res.status(400).json({ success: false, error: 'title, minecraftVersion and fileData are required' });
    }

    // Validate file size
    const fileBuffer = Buffer.from(fileData, 'base64');
    if (fileBuffer.length > MAX_FILE_SIZE) {
      return res.status(413).json({ success: false, error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB` });
    }

    // Generate unique share code (retry on collision)
    let shareCode = '';
    let attempts = 0;
    while (attempts < 10) {
      shareCode = generateShareCode();
      const existing = await pool.query('SELECT id FROM bamboo_shares WHERE share_code = $1', [shareCode]);
      if (existing.rows.length === 0) break;
      attempts++;
    }
    if (attempts >= 10) {
      return res.status(500).json({ success: false, error: 'Could not generate unique share code' });
    }

    // Save file to storage
    const safeFileName = sanitizeFileName(fileName || `share-${shareCode}.bamboo`);
    const filePath = path.join(SHARE_STORAGE_DIR, `${shareCode}-${safeFileName}`);
    
    // Validate path is safe
    if (!isPathSafe(filePath, SHARE_STORAGE_DIR)) {
      return res.status(400).json({ success: false, error: 'Invalid file path' });
    }

    fs.writeFileSync(filePath, fileBuffer);

    // Compute hash
    const fileHash = await computeFileHash(filePath);
    const fileSize = fileBuffer.length;

    // Calculate expiry (30 days from now)
    const expiresAt = new Date(Date.now() + SHARE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // Insert into database
    const result = await pool.query(
      `INSERT INTO bamboo_shares 
       (id, share_code, author_id, author_name, title, description, minecraft_version, 
        modloader, modloader_version, file_size, mod_count, resourcepack_count, 
        shader_count, datapack_count, world_count, file_storage_path, file_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        uuidv4(), shareCode, authorId || null, authorName || 'Unknown',
        title, description || '', minecraftVersion,
        modloader || 'Vanilla', modloaderVersion || '',
        fileSize, modCount || 0, resourcepackCount || 0,
        shaderCount || 0, datapackCount || 0, worldCount || 0,
        filePath, fileHash, expiresAt,
      ]
    );

    console.log(`[share] Created share '${title}' with code ${shareCode}`);

    res.status(201).json({
      success: true,
      data: {
        shareCode,
        title,
        description: description || '',
        minecraftVersion,
        modloader: modloader || 'Vanilla',
        modloaderVersion: modloaderVersion || '',
        fileSize,
        modCount: modCount || 0,
        resourcepackCount: resourcepackCount || 0,
        shaderCount: shaderCount || 0,
        datapackCount: datapackCount || 0,
        worldCount: worldCount || 0,
        authorName: authorName || 'Unknown',
        expiresAt: expiresAt.toISOString(),
        createdAt: result.rows[0].created_at ? new Date(result.rows[0].created_at).toISOString() : new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[share] Create error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// GET SHARE INFO (preview without downloading)
// GET /api/share/info/:code
// ============================================================
router.get('/info/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    if (!code || code.length < 4) {
      return res.status(400).json({ success: false, error: 'Invalid share code' });
    }

    const result = await pool.query(
      `SELECT * FROM bamboo_shares WHERE share_code = $1 AND is_active = true 
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [code.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Share not found or expired' });
    }

    const share = result.rows[0];

    res.json({
      success: true,
      data: {
        shareCode: share.share_code,
        title: share.title,
        description: share.description || '',
        minecraftVersion: share.minecraft_version,
        modloader: share.modloader,
        modloaderVersion: share.modloader_version || '',
        fileSize: share.file_size,
        modCount: share.mod_count,
        resourcepackCount: share.resourcepack_count,
        shaderCount: share.shader_count,
        datapackCount: share.datapack_count,
        worldCount: share.world_count,
        downloadCount: share.download_count,
        authorName: share.author_name,
        createdAt: share.created_at ? new Date(share.created_at).toISOString() : null,
        expiresAt: share.expires_at ? new Date(share.expires_at).toISOString() : null,
      },
    });
  } catch (err) {
    console.error('[share] Info error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// DOWNLOAD SHARE
// GET /api/share/download/:code
// ============================================================
router.get('/download/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    if (!code || code.length < 4) {
      return res.status(400).json({ success: false, error: 'Invalid share code' });
    }

    const result = await pool.query(
      `SELECT * FROM bamboo_shares WHERE share_code = $1 AND is_active = true 
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [code.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Share not found or expired' });
    }

    const share = result.rows[0];

    // Check file exists
    if (!share.file_storage_path || !fs.existsSync(share.file_storage_path)) {
      return res.status(404).json({ success: false, error: 'Share file not found on server' });
    }

    // Validate path is safe
    if (!isPathSafe(share.file_storage_path, SHARE_STORAGE_DIR)) {
      return res.status(500).json({ success: false, error: 'Invalid storage path' });
    }

    // Increment download count
    await pool.query(
      'UPDATE bamboo_shares SET download_count = download_count + 1 WHERE id = $1',
      [share.id]
    );

    // Track download
    await pool.query(
      `INSERT INTO share_downloads (id, share_id, downloader_ip, downloader_username, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        uuidv4(), share.id,
        req.ip || req.connection?.remoteAddress || '',
        req.query.username || '',
        req.headers['user-agent'] || '',
      ]
    );

    console.log(`[share] Downloaded share '${share.title}' (code: ${code})`);

    // Send file
    const fileName = sanitizeFileName(`${share.title}-${share.share_code}.bamboo`);
    res.download(share.file_storage_path, fileName, (err) => {
      if (err) {
        console.warn('[share] Download error:', err.message);
      }
    });
  } catch (err) {
    console.error('[share] Download error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// VALIDATE SHARE CODE
// GET /api/share/validate/:code
// ============================================================
router.get('/validate/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    if (!code || code.length < 4) {
      return res.json({ success: true, valid: false, reason: 'Code too short' });
    }

    const result = await pool.query(
      `SELECT id FROM bamboo_shares WHERE share_code = $1 AND is_active = true 
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [code.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, valid: false, reason: 'Share not found or expired' });
    }

    res.json({ success: true, valid: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// LIST SHARES BY AUTHOR
// GET /api/share/author/:authorId
// ============================================================
router.get('/author/:authorId', async (req, res) => {
  try {
    const { authorId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await pool.query(
      `SELECT * FROM bamboo_shares WHERE author_id = $1 
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [authorId, parseInt(limit), offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) as cnt FROM bamboo_shares WHERE author_id = $1',
      [authorId]
    );

    res.json({
      success: true,
      data: result.rows.map(share => ({
        shareCode: share.share_code,
        title: share.title,
        description: share.description || '',
        minecraftVersion: share.minecraft_version,
        modloader: share.modloader,
        fileSize: share.file_size,
        downloadCount: share.download_count,
        createdAt: share.created_at ? new Date(share.created_at).toISOString() : null,
        expiresAt: share.expires_at ? new Date(share.expires_at).toISOString() : null,
        isActive: share.is_active,
      })),
      total: parseInt(countResult.rows[0].cnt),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// DELETE SHARE
// DELETE /api/share/:code
// ============================================================
router.delete('/:code', async (req, res) => {
  try {
    const { code } = req.params;

    const result = await pool.query(
      'SELECT * FROM bamboo_shares WHERE share_code = $1',
      [code.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Share not found' });
    }

    const share = result.rows[0];

    // Remove file
    if (share.file_storage_path && fs.existsSync(share.file_storage_path)) {
      try {
        fs.unlinkSync(share.file_storage_path);
      } catch (e) {
        console.warn('[share] Could not delete file:', e.message);
      }
    }

    // Delete from database (cascade removes share_downloads)
    await pool.query('DELETE FROM bamboo_shares WHERE id = $1', [share.id]);

    console.log(`[share] Deleted share '${share.title}' (code: ${code})`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// GET SHARE STATS
// GET /api/share/stats
// ============================================================
router.get('/stats', async (req, res) => {
  try {
    const totalShares = await pool.query('SELECT COUNT(*) as cnt FROM bamboo_shares');
    const activeShares = await pool.query(
      "SELECT COUNT(*) as cnt FROM bamboo_shares WHERE is_active = true AND (expires_at IS NULL OR expires_at > NOW())"
    );
    const totalDownloads = await pool.query(
      'SELECT COALESCE(SUM(download_count), 0) as cnt FROM bamboo_shares'
    );
    const totalSize = await pool.query(
      'SELECT COALESCE(SUM(file_size), 0) as cnt FROM bamboo_shares'
    );

    res.json({
      success: true,
      data: {
        totalShares: parseInt(totalShares.rows[0].cnt),
        activeShares: parseInt(activeShares.rows[0].cnt),
        totalDownloads: parseInt(totalDownloads.rows[0].cnt),
        totalSizeBytes: parseInt(totalSize.rows[0].cnt),
        storagePath: SHARE_STORAGE_DIR,
        maxFileSize: MAX_FILE_SIZE,
        expiryDays: SHARE_EXPIRY_DAYS,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// CLEANUP ROUTE (admin only - for cleanup)
// POST /api/share/cleanup
// ============================================================
router.post('/cleanup', async (req, res) => {
  try {
    await cleanExpiredShares();
    
    // Also remove orphaned files (files without DB entry)
    if (fs.existsSync(SHARE_STORAGE_DIR)) {
      const files = fs.readdirSync(SHARE_STORAGE_DIR);
      let orphanedCount = 0;
      
      for (const file of files) {
        const filePath = path.join(SHARE_STORAGE_DIR, file);
        if (!fs.statSync(filePath).isFile()) continue;
        
        const dbEntry = await pool.query(
          'SELECT id FROM bamboo_shares WHERE file_storage_path = $1',
          [filePath]
        );
        
        if (dbEntry.rows.length === 0) {
          fs.unlinkSync(filePath);
          orphanedCount++;
        }
      }
      
      console.log(`[share] Cleanup: removed ${orphanedCount} orphaned files`);
    }
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = { router, init, SHARE_STORAGE_DIR, cleanExpiredShares };
