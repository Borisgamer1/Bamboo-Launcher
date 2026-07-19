// ======================================================================
// === UNIFIED CONTENT MANAGER API ======================================
// ======================================================================
// ALL content types (cosmetics, news, events, banners, themes,
// backgrounds, icons, etc.) are stored in the single 'assets' table.
// Type-specific fields are stored in the 'metadata' JSONB column.
// This module provides a simplified admin-facing CRUD interface
// that abstracts away slugs, file paths, and technical details.
// ======================================================================

module.exports = function contentRoutes(app, ctx) {
  const { pool, dbState, authenticateAdmin, uuidv4, multer } = ctx;

  // File system dependencies
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');

  // ===== Configuration =====
  const CONTENT_ROOT = process.env.BAMBOO_CONTENT_REPO || (
    process.env.NODE_ENV === 'production'
      ? '/tmp/bamboo-content'
      : path.resolve(__dirname, '..', '..', '..', 'BambooContent')
  );

  // Allowed content types (mapped to asset_type in the assets table)
  // Backgrounds are part of themes — not a standalone content type.
  const CONTENT_TYPES = [
    'cosmetic', 'news', 'event', 'banner', 'theme',
    'icon', 'ui_asset', 'music', 'shader', 'resource_pack', 'font', 'other'
  ];

  // ===== Helpers =====

  /** Generate a URL-safe slug from a name */
  function generateSlug(name) {
    return name
      .toLowerCase()
      .replace(/[^\w\s-]/g, '') // remove non-word chars
      .replace(/\s+/g, '-')      // spaces to dashes
      .replace(/-+/g, '-')       // collapse multiple dashes
      .replace(/^-|-$/g, '')     // trim leading/trailing dashes
      .substring(0, 128);        // limit length
  }

  /** Ensure a unique slug by appending a counter if needed */
  async function ensureUniqueSlug(baseSlug) {
    let slug = baseSlug;
    let counter = 1;
    while (true) {
      const r = await pool.query('SELECT id FROM assets WHERE slug = $1', [slug]);
      if (r.rows.length === 0) return slug;
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
  }

  /** Map an asset DB row to a content item response */
  function mapContentItem(assetType, row, files) {
    const base = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description || '',
      status: row.status,
      version: row.version,
      category: row.category || 'general',
      tags: row.tags || [],
      thumbnailUrl: row.thumbnail_url || '',
      previewUrl: row.preview_url || '',
      metadata: row.metadata || {},
      isActive: row.is_active,
      sortOrder: row.sort_order || 0,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
      fileCount: files ? files.length : 0,
      files: files || [],
    };

    // Type-specific response shaping
    switch (assetType) {
      case 'cosmetic':
        return {
          ...base,
          type: (row.metadata && row.metadata.cosmeticType) || 'cape',
          rarity: (row.metadata && row.metadata.rarity) || 'common',
          imageUrl: row.thumbnail_url || row.preview_url || '',
          modelUrl: (row.metadata && row.metadata.modelUrl) || '',
          accentColor: (row.metadata && row.metadata.accentColor) || '',
        };
      case 'news':
        return {
          ...base,
          title: row.name,
          subtitle: (row.metadata && row.metadata.subtitle) || '',
          content: (row.metadata && row.metadata.content) || '',
          bannerUrl: row.thumbnail_url || '',
          author: (row.metadata && row.metadata.author) || 'Bamboo Team',
          publishedAt: (row.metadata && row.metadata.publishedAt) || null,
          isVisible: row.is_active,
          isPinned: (row.metadata && row.metadata.isPinned) || false,
          gameVersion: (row.metadata && row.metadata.gameVersion) || '',
        };
      case 'event':
        return {
          ...base,
          title: row.name,
          subtitle: (row.metadata && row.metadata.subtitle) || '',
          description: row.description || '',
          bannerUrl: row.thumbnail_url || '',
          startDate: (row.metadata && row.metadata.startDate) || new Date().toISOString(),
          endDate: (row.metadata && row.metadata.endDate) || null,
          isActive: (row.metadata && row.metadata.isActive !== false),
          isVisible: row.is_active,
          priority: (row.metadata && row.metadata.priority) || 0,
          author: (row.metadata && row.metadata.author) || 'Bamboo Team',
        };
      case 'banner':
        return {
          ...base,
          title: row.name,
          imageUrl: row.thumbnail_url || '',
          description: row.description || '',
          clickTarget: (row.metadata && row.metadata.clickTarget) || '',
          clickType: (row.metadata && row.metadata.clickType) || 'external',
          sortOrder: row.sort_order || 0,
          isActive: row.is_active,
          startDate: (row.metadata && row.metadata.startDate) || null,
          endDate: (row.metadata && row.metadata.endDate) || null,
          priority: (row.metadata && row.metadata.priority) || 0,
        };
      case 'theme':
        return {
          ...base,
          title: row.name,
          accentColor: (row.metadata && row.metadata.accentColor) || '',
          backgroundColor: (row.metadata && row.metadata.backgroundColor) || '',
          backgroundImage: (row.metadata && row.metadata.backgroundImage) || '',
          fontFamily: (row.metadata && row.metadata.fontFamily) || '',
          iconFile: (row.metadata && row.metadata.iconFile) || '',
        };
      default:
        return base;
    }
  }

  /** Compute SHA-256 hash of a file */
  function computeFileHash(filePath) {
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      const hash = crypto.createHash('sha256');
      stream.on('data', d => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /** Recursively walk a directory and return file info */
  function walkDir(dir, baseDir, depth = 0) {
    const results = [];
    if (!fs.existsSync(dir) || depth > 10) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
       if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'Thumbs.db' || entry.name === '.DS_Store') continue;
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, baseDir, depth + 1));
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          results.push({ path: relativePath, size: stat.size, fullPath });
        } catch (e) { /* skip */ }
      }
    }
    return results;
  }

  /** Generate and write manifest.json to content repo */
  async function generateManifest() {
    if (!fs.existsSync(CONTENT_ROOT)) return null;
    const files = walkDir(CONTENT_ROOT, CONTENT_ROOT);
    files.sort((a, b) => a.path.localeCompare(b.path));

    // Hash each file
    const hashedFiles = [];
    for (const f of files) {
      try {
        const hash = await computeFileHash(f.fullPath);
        hashedFiles.push({ path: f.path, hash, size: f.size });
      } catch (e) {
        console.warn('[content] Could not hash', f.path, e.message);
      }
    }

    // Determine version
    let version = 1;
    const manifestPath = path.join(CONTENT_ROOT, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const oldMap = new Map(existing.files.map(f => [f.path, f.hash]));
        const newMap = new Map(hashedFiles.map(f => [f.path, f.hash]));
        let changed = oldMap.size !== newMap.size;
        if (!changed) {
          for (const [p, h] of newMap) {
            if (oldMap.get(p) !== h) { changed = true; break; }
          }
        }
        version = changed ? (existing.version || 0) + 1 : (existing.version || 1);
      } catch { /* ignore */ }
    }

    const manifest = {
      schemaVersion: 1,
      version,
      updatedAt: new Date().toISOString(),
      files: hashedFiles,
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    return manifest;
  }

  /** Try to git commit and push content changes */
  async function gitPushContent() {
    try {
      const simpleGit = require('simple-git');
      const git = simpleGit(CONTENT_ROOT);
      const status = await git.status();
      if (status.files.length === 0) return { success: true, message: 'No changes to push' };

      await git.add('.');
      await git.commit(`Content update: ${new Date().toISOString().split('T')[0]}`);
      await git.push('origin', 'main');
      return { success: true, message: 'Changes pushed to GitHub' };
    } catch (err) {
      // Git not configured or not a repo — that's OK, manifest is still updated
      console.warn('[content] Git push skipped:', err.message);
      return { success: false, message: `Git push skipped: ${err.message}` };
    }
  }

  /** Validate content type */
  function validateType(assetType) {
    if (!assetType) return 'cosmetic';
    const t = assetType.toLowerCase();
    // Map plural to singular if needed (e.g. "cosmetics" -> "cosmetic")
    if (t.endsWith('s') && !CONTENT_TYPES.includes(t)) {
      const singular = t.slice(0, -1);
      if (CONTENT_TYPES.includes(singular)) return singular;
    }
    if (CONTENT_TYPES.includes(t)) return t;
    return null;
  }

  // ====================================================================
  // === FILE/ASSET BROWSING API (must be BEFORE content type routes!) ===
  // ====================================================================
  // These routes MUST be registered before /api/content/:type to prevent
  // Express from matching "files" as a content type parameter.
  // ====================================================================

  // ===== GET /api/content/files — Browse/search files in the repo =====
  app.get('/api/content/files', authenticateAdmin, (req, res) => {
    try {
      if (!fs.existsSync(CONTENT_ROOT)) {
        return res.json({ success: true, items: [], path: '/', total: 0, page: 1, limit: 50 });
      }

      const subDir = (req.query.dir || '').replace(/\\\\/g, '/').replace(/\.\./g, '');
      const searchQuery = (req.query.q || '').trim().toLowerCase();
      const typeFilter = (req.query.type || 'all').toLowerCase();
      const page = Math.max(1, parseInt(req.query.page || '1'));
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50')));

      const browsePath = subDir ? path.join(CONTENT_ROOT, subDir) : CONTENT_ROOT;

      const resolved = path.resolve(browsePath);
      const resolvedRoot = path.resolve(CONTENT_ROOT);
      if (!resolved.startsWith(resolvedRoot)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (!fs.existsSync(browsePath)) {
        return res.status(404).json({ error: 'Directory not found' });
      }

      const typeMatch = {
        image: f => /\.(png|jpg|jpeg|webp|gif|svg|ico)$/i.test(f),
        model: f => /\.(glb|gltf|bbmodel|json)$/i.test(f),
        audio: f => /\.(mp3|ogg|wav)$/i.test(f),
        json: f => /\.json$/i.test(f),
        font: f => /\.(ttf|otf|woff2)$/i.test(f),
        archive: f => /\.zip$/i.test(f),
        // Context-specific filters for the Asset Browser
        texture: f => /\.(png)$/i.test(f),
        glb: f => /\.(glb|gltf|bbmodel|json)$/i.test(f),
        icon: f => /\.(png|jpg|jpeg|webp|gif|svg|ico)$/i.test(f),
      };

      let allItems = [];

      if (searchQuery) {
        const walkDir = (dir, baseDir, depth) => {
          if (depth > 8) return;
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.name === '.git' || e.name === 'node_modules' || e.name === 'manifest.json') continue;
            const full = path.join(dir, e.name);
            const rel = path.relative(baseDir, full).replace(/\\\\/g, '/');
            if (e.isDirectory()) {
              walkDir(full, baseDir, depth + 1);
            } else if (e.isFile()) {
              if (rel.toLowerCase().includes(searchQuery)) {
                try {
                  const stat = fs.statSync(full);
                  allItems.push({ name: e.name, path: rel, type: 'file', size: stat.size, mtime: stat.mtime.toISOString() });
                } catch {}
              }
            }
          }
        };
        walkDir(browsePath, CONTENT_ROOT, 0);
      } else {
        const entries = fs.readdirSync(browsePath, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === '.git' || e.name === 'node_modules' || e.name === 'manifest.json') continue;
          const full = path.join(browsePath, e.name);
          const rel = path.relative(CONTENT_ROOT, full).replace(/\\\\/g, '/');
          if (e.isDirectory()) {
            let childCount = 0;
            try { childCount = fs.readdirSync(full).filter(x => !x.startsWith('.')).length; } catch {}
            allItems.push({ name: e.name, path: rel, type: 'directory', fileCount: childCount });
          } else if (e.isFile()) {
            try {
              const stat = fs.statSync(full);
              allItems.push({ name: e.name, path: rel, type: 'file', size: stat.size, mtime: stat.mtime.toISOString() });
            } catch {}
          }
        }

        allItems.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      }

      if (typeFilter !== 'all' && typeMatch[typeFilter]) {
        allItems = allItems.filter(i => i.type === 'directory' || typeMatch[typeFilter](i.name));
      }

      const total = allItems.length;
      const offset = (page - 1) * limit;
      const items = allItems.slice(offset, offset + limit);
      const parentDir = subDir ? subDir.split('/').slice(0, -1).join('/') : null;

      return res.json({
        success: true,
        path: subDir || '/',
        parentDir: parentDir || null,
        items,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== GET /api/content/files/preview — Get file preview data =======
  app.get('/api/content/files/preview', authenticateAdmin, (req, res) => {
    try {
      const filePath = (req.query.path || '').replace(/\\\\/g, '/').replace(/\.\./g, '');
      if (!filePath) return res.status(400).json({ error: 'File path required' });

      const fullPath = path.join(CONTENT_ROOT, filePath);
      const resolved = path.resolve(fullPath);
      const resolvedRoot = path.resolve(CONTENT_ROOT);
      if (!resolved.startsWith(resolvedRoot)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
      }

      const stat = fs.statSync(fullPath);
      const ext = path.extname(filePath).toLowerCase();
      const isImage = /^\.(png|jpg|jpeg|webp|gif|svg|ico)$/i.test(ext);

      const preview = {
        name: path.basename(filePath),
        path: filePath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        ext,
        isImage,
      };

      if (isImage) {
        const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
        preview.mimeType = mimeMap[ext] || 'image/png';
        if (stat.size < 1024 * 1024) {
          const data = fs.readFileSync(fullPath);
          preview.base64 = `data:${preview.mimeType};base64,${data.toString('base64')}`;
        }
      }

      // Also return a direct URL for image serving in the browser
      if (isImage) {
        preview.url = `/api/content/files/serve?path=${encodeURIComponent(filePath)}`;
      }

      return res.json({ success: true, data: preview });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== GET /api/content/files/serve — Direct file serving ===========
  app.get('/api/content/files/serve', authenticateAdmin, (req, res) => {
    try {
      const filePath = (req.query.path || '').replace(/\\\\/g, '/').replace(/\.\./g, '');
      if (!filePath) return res.status(400).json({ error: 'File path required' });

      const fullPath = path.join(CONTENT_ROOT, filePath);
      const resolved = path.resolve(fullPath);
      const resolvedRoot = path.resolve(CONTENT_ROOT);
      if (!resolved.startsWith(resolvedRoot)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
        '.bbmodel': 'application/octet-stream',
      };
      const mimeType = mimeMap[ext] || 'application/octet-stream';

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const stream = fs.createReadStream(fullPath);
      stream.pipe(res);
      stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === GET /api/content/:type — List items of a content type ==========
  // ====================================================================
  app.get('/api/content/:type', async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });

      const assetType = validateType(req.params.type);
      if (!assetType) return res.status(400).json({ error: `Invalid content type: ${req.params.type}. Allowed: ${CONTENT_TYPES.join(', ')}` });

      const { category, status, search, active, page = 1, limit = 50, sortBy = 'updatedAt', sortDir = 'desc' } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let q = 'SELECT * FROM assets WHERE asset_type = $1';
      const params = [assetType];
      let i = 2;

      if (active === 'true') { q += ` AND is_active = true`; }
      else if (active === 'false') { q += ` AND is_active = false`; }

      if (category && category !== 'all') { q += ` AND category = $${i++}`; params.push(category); }
      if (status && status !== 'all') { q += ` AND status = $${i++}`; params.push(status); }
      if (search) { q += ` AND (name ILIKE $${i} OR description ILIKE $${i})`; params.push(`%${search}%`); i++; }

      const sortCols = { name: 'name', status: 'status', version: 'version', updated: 'updated_at', created: 'created_at', sortOrder: 'sort_order' };
      const col = sortCols[sortBy] || 'updated_at';
      const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
      q += ` ORDER BY ${col} ${dir}`;

      const countQ = q.replace('SELECT *', 'SELECT COUNT(*)').split('ORDER BY')[0];
      q += ` LIMIT $${i++} OFFSET $${i++}`;
      params.push(parseInt(limit), offset);

      const [items, countResult] = await Promise.all([
        pool.query(q, params),
        pool.query(countQ, params.slice(0, -2)),
      ]);

      const result = [];
      for (const row of items.rows) {
        const fileRows = await pool.query('SELECT * FROM asset_files WHERE asset_id = $1 ORDER BY sort_order, file_name', [row.id]);
        result.push(mapContentItem(assetType, row, fileRows.rows.map(r => ({
          id: r.id, fileName: r.file_name, filePath: r.file_path,
          fileType: r.file_type, fileSize: r.file_size, fileHash: r.file_hash,
        }))));
      }

      return res.json({
        data: result,
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === GET /api/content/:type/:id — Get single content item ==========
  // ====================================================================
  app.get('/api/content/:type/:id', async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });

      const assetType = validateType(req.params.type);
      if (!assetType) return res.status(400).json({ error: 'Invalid content type' });

      const r = await pool.query('SELECT * FROM assets WHERE id = $1 AND asset_type = $2', [req.params.id, assetType]);
      if (!r.rows.length) return res.status(404).json({ error: 'Content not found' });

      const fileRows = await pool.query('SELECT * FROM asset_files WHERE asset_id = $1 ORDER BY sort_order, file_name', [r.rows[0].id]);
      return res.json(mapContentItem(assetType, r.rows[0], fileRows.rows.map(fr => ({
        id: fr.id, fileName: fr.file_name, filePath: fr.file_path,
        fileType: fr.file_type, fileSize: fr.file_size, fileHash: fr.file_hash,
      }))));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === POST /api/content/:type — Create new content item =============
  // ====================================================================
  app.post('/api/content/:type', authenticateAdmin, async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });

      const assetType = validateType(req.params.type);
      if (!assetType) return res.status(400).json({ error: 'Invalid content type' });

      const { name, description, category, metadata, tags } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Name is required' });
      }

      // Auto-generate slug from name
      let slug = generateSlug(name);
      if (!slug) slug = `item-${Date.now()}`;
      slug = await ensureUniqueSlug(slug);

      const id = uuidv4();
      const mergedMetadata = { ...(metadata || {}) };
      // Copy cosmetic-specific fields from body into metadata
      if (assetType === 'cosmetic') {
        if (req.body.type) mergedMetadata.cosmeticType = req.body.type;
        if (req.body.rarity) mergedMetadata.rarity = req.body.rarity;
        if (req.body.accentColor) mergedMetadata.accentColor = req.body.accentColor;
        if (req.body.modelUrl) mergedMetadata.modelUrl = req.body.modelUrl;
      }

      const r = await pool.query(
        `INSERT INTO assets (id, slug, name, description, asset_type, category, status, tags, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [id, slug, name.trim(), description || '', assetType, category || 'general', 'draft', tags || [], JSON.stringify(mergedMetadata)]
      );

      return res.status(201).json(mapContentItem(assetType, r.rows[0], []));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === PUT /api/content/:type/:id — Update content item ==============
  // ====================================================================
  app.put('/api/content/:type/:id', authenticateAdmin, async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });

      const assetType = validateType(req.params.type);
      if (!assetType) return res.status(400).json({ error: 'Invalid content type' });

      const ex = await pool.query('SELECT * FROM assets WHERE id = $1 AND asset_type = $2', [req.params.id, assetType]);
      if (!ex.rows.length) return res.status(404).json({ error: 'Content not found' });

      const existing = ex.rows[0];
      const { name, description, category, metadata, tags, status, isActive, sortOrder } = req.body;

      // Merge metadata (preserve existing, override with new)
      const existingMeta = existing.metadata || {};
      const mergedMeta = { ...existingMeta, ...(metadata || {}) };

      // Copy cosmetic-specific fields from body into metadata
      if (assetType === 'cosmetic') {
        if (req.body.type !== undefined) mergedMeta.cosmeticType = req.body.type;
        if (req.body.rarity !== undefined) mergedMeta.rarity = req.body.rarity;
        if (req.body.accentColor !== undefined) mergedMeta.accentColor = req.body.accentColor;
        if (req.body.modelUrl !== undefined) mergedMeta.modelUrl = req.body.modelUrl;
      }

      let updatedSlug = existing.slug;
      if (name && name.trim() !== existing.name) {
        updatedSlug = await ensureUniqueSlug(generateSlug(name));
      }

      const r = await pool.query(
        `UPDATE assets SET name = COALESCE($2, name), description = COALESCE($3, description),
         category = COALESCE($4, category), tags = COALESCE($5, tags),
         metadata = $6, status = COALESCE($7, status),
         is_active = COALESCE($8, is_active), sort_order = COALESCE($9, sort_order),
         slug = COALESCE($10, slug), updated_at = NOW() WHERE id = $1 RETURNING *`,
        [req.params.id, name ? name.trim() : null, description, category, tags,
         JSON.stringify(mergedMeta), status, isActive !== undefined ? isActive : null,
         sortOrder, updatedSlug !== existing.slug ? updatedSlug : null]
      );

      const fileRows = await pool.query('SELECT * FROM asset_files WHERE asset_id = $1 ORDER BY sort_order, file_name', [r.rows[0].id]);
      return res.json(mapContentItem(assetType, r.rows[0], fileRows.rows.map(fr => ({
        id: fr.id, fileName: fr.file_name, filePath: fr.file_path,
        fileType: fr.file_type, fileSize: fr.file_size, fileHash: fr.file_hash,
      }))));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === DELETE /api/content/:type/:id — Delete content item ============
  // ====================================================================
  app.delete('/api/content/:type/:id', authenticateAdmin, async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });

      const assetType = validateType(req.params.type);
      if (!assetType) return res.status(400).json({ error: 'Invalid content type' });

      // Delete from database (cascades to asset_files)
      const r = await pool.query('DELETE FROM assets WHERE id = $1 AND asset_type = $2 RETURNING *', [req.params.id, assetType]);
      if (!r.rows.length) return res.status(404).json({ error: 'Content not found' });

      // Clean up files from disk
      const itemDir = path.join(CONTENT_ROOT, assetType + 's', r.rows[0].slug);
      if (fs.existsSync(itemDir)) {
        try {
          fs.rmSync(itemDir, { recursive: true, force: true });
        } catch (e) {
          console.warn('[content] Could not delete directory:', itemDir, e.message);
        }
      }

      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === POST /api/content/:type/:id/upload — Upload files =============
  // ====================================================================
  app.post('/api/content/:type/:id/upload', authenticateAdmin, async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });

      const assetType = validateType(req.params.type);
      if (!assetType) return res.status(400).json({ error: 'Invalid content type' });

      const asset = await pool.query('SELECT * FROM assets WHERE id = $1 AND asset_type = $2', [req.params.id, assetType]);
      if (!asset.rows.length) return res.status(404).json({ error: 'Content not found' });
      const item = asset.rows[0];

      if (!multer) return res.status(500).json({ error: 'Multer not available' });

      // Dynamic multer setup for this upload
      const contentTypesDir = path.join(CONTENT_ROOT, assetType + 's', item.slug);
      if (!fs.existsSync(contentTypesDir)) {
        fs.mkdirSync(contentTypesDir, { recursive: true });
      }

      const upload = multer({
        storage: multer.diskStorage({
          destination: (req, file, cb) => cb(null, contentTypesDir),
          filename: (req, file, cb) => {
            const safeName = file.originalname.replace(/[^a-zA-Z0-9._\-\/\\ ]/g, '_');
            cb(null, safeName);
          },
        }),
        limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
      }).any(); // Accept any fields, any number of files

      return new Promise((resolve) => {
        upload(req, res, async (err) => {
          if (err) {
            return resolve(res.status(400).json({ error: err.message }));
          }

          const uploadedFiles = req.files || [];
          if (uploadedFiles.length === 0) {
            return resolve(res.status(400).json({ error: 'No files uploaded' }));
          }

          const addedFiles = [];
          for (const file of uploadedFiles) {
            const relativePath = path.relative(CONTENT_ROOT, file.path).replace(/\\/g, '/');
            let hash = '';
            try { hash = await computeFileHash(file.path); } catch {}

            const fileId = uuidv4();
            const fileName = file.filename || file.originalname;
            const fileType = guessFileType(fileName);

            try {
              await pool.query(
                `INSERT INTO asset_files (id, asset_id, file_path, file_name, file_type, file_hash, file_size, mime_type, disk_path)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (asset_id, file_name) DO UPDATE SET
                   file_path = EXCLUDED.file_path, file_type = EXCLUDED.file_type,
                   file_hash = EXCLUDED.file_hash, file_size = EXCLUDED.file_size,
                   mime_type = EXCLUDED.mime_type, disk_path = EXCLUDED.disk_path,
                   updated_at = NOW() RETURNING *`,
                [fileId, item.id, relativePath, fileName, fileType, hash, file.size, file.mimetype || 'application/octet-stream', file.path]
              );
              addedFiles.push({ fileName, filePath: relativePath, fileType, fileSize: file.size, fileHash: hash });
            } catch (pgErr) {
              console.warn('[content] Could not insert file record:', pgErr.message);
            }
          }

          // Sort thumbnails: pick first image as thumbnail
          if (!item.thumbnail_url && !item.preview_url) {
            const images = addedFiles.filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f.fileName));
            if (images.length > 0) {              const thumb = path.join(assetType + 's', item.slug, images[0].fileName).replace(/\\/g, '/');
               try {
                await pool.query('UPDATE assets SET thumbnail_url = $1, preview_url = $1, updated_at = NOW() WHERE id = $2', [thumb, item.id]);
              } catch {}
            }
          }

          // Update the asset's version and mark as needing manifest update
          await pool.query('UPDATE assets SET version = version + 1, updated_at = NOW() WHERE id = $1', [item.id]);

          return resolve(res.json({
            success: true,
            files: addedFiles,
            message: `${addedFiles.length} file(s) uploaded successfully`,
          }));
        });
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Guess file type from extension */
  function guessFileType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const typeMap = {
      '.png': 'texture', '.jpg': 'texture', '.jpeg': 'texture', '.webp': 'texture', '.gif': 'texture',
      '.glb': 'model', '.gltf': 'model', '.bbmodel': 'model',
      '.ico': 'icon', '.svg': 'icon',
      '.mp3': 'audio', '.ogg': 'audio', '.wav': 'audio',
      '.ttf': 'font', '.otf': 'font', '.woff2': 'font',
      '.json': 'config', '.css': 'config', '.js': 'config',
      '.mp4': 'other', '.zip': 'other', '.bin': 'other',
      '.lottie': 'other',
    };
    return typeMap[ext] || 'other';
  }

  // ====================================================================
  // === POST /api/content/:type/:id/publish — Publish content =========
  // ====================================================================
  app.post('/api/content/:type/:id/publish', authenticateAdmin, async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });

      const assetType = validateType(req.params.type);
      if (!assetType) return res.status(400).json({ error: 'Invalid content type' });

      const r = await pool.query('SELECT * FROM assets WHERE id = $1 AND asset_type = $2', [req.params.id, assetType]);
      if (!r.rows.length) return res.status(404).json({ error: 'Content not found' });

      const item = r.rows[0];

      // 1. Set status to 'published'
      await pool.query('UPDATE assets SET status = $2, updated_at = NOW() WHERE id = $1', [item.id, 'published']);

      // 2. Generate manifest
      const manifest = await generateManifest();

      // 3. Try git push
      const gitResult = await gitPushContent();

      return res.json({
        success: true,
        manifest,
        git: gitResult,
        message: `"${item.name}" published successfully`,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === POST /api/content/publish-all — Publish all pending ============
  // ====================================================================
  app.post('/api/content/publish-all', authenticateAdmin, async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });

      // Publish all draft items
      await pool.query('UPDATE assets SET status = $1, updated_at = NOW() WHERE status = $2', ['published', 'draft']);

      // Generate manifest
      const manifest = await generateManifest();

      // Try git push
      const gitResult = await gitPushContent();

      return res.json({
        success: true,
        manifest,
        git: gitResult,
        message: 'All content published successfully',
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === GET /api/content/:type/:id/image — Serve content image =======
  // ====================================================================
  app.get('/api/content/:type/:id/image', async (req, res) => {
    try {
      const assetType = validateType(req.params.type);
      if (!assetType) return res.status(400).json({ error: 'Invalid content type' });

      const r = await pool.query('SELECT slug, thumbnail_url, preview_url FROM assets WHERE id = $1 AND asset_type = $2', [req.params.id, assetType]);
      if (!r.rows.length) return res.status(404).json({ error: 'Content not found' });

      const item = r.rows[0];
      // Look for images in the content repo directory
      const contentDir = path.join(CONTENT_ROOT, assetType + 's', item.slug);
      if (!fs.existsSync(contentDir)) {
        return res.status(404).json({ error: 'No content directory found' });
      }

      const imageFiles = fs.readdirSync(contentDir).filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f));
      if (imageFiles.length === 0) return res.status(404).json({ error: 'No images found' });

      // Prefer files with 'preview' in name, then first image
      const chosen = imageFiles.find(f => /preview|thumb/i.test(f)) || imageFiles[0];
      const imagePath = path.join(contentDir, chosen);

      if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'Image not found' });

      const ext = path.extname(chosen).toLowerCase();
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
      res.setHeader('Content-Type', mimeMap[ext] || 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const stream = fs.createReadStream(imagePath);
      stream.pipe(res);
      stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === POST /api/migrate/old-tables — One-time data migration =========
  // ====================================================================
  app.post('/api/migrate/old-tables', authenticateAdmin, async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });

      const results = [];

      // Helper to migrate data from one legacy table to assets
      const migrateTable = async (tableName, assetType, mapper) => {
        try {
          const { rows } = await pool.query(`SELECT * FROM ${tableName}`);
          let migrated = 0;
          for (const item of rows) {
            const slug = item.slug || mapper.slug(item);
            const exists = await pool.query('SELECT id FROM assets WHERE slug = $1', [slug]);
            if (exists.rows.length > 0) continue;

            const metadata = mapper.metadata(item);
            const id = item.id || uuidv4();
            await pool.query(
              `INSERT INTO assets (id, slug, name, description, asset_type, category, status, tags, thumbnail_url, preview_url, metadata, is_active, sort_order, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
               ON CONFLICT (slug) DO NOTHING`,
              [id, slug, item.name || item.title, item.description || '', assetType, mapper.category(item) || 'general',
               item.is_active !== false ? 'published' : 'draft', mapper.tags(item) || [],
               item.image_url || item.thumbnail_url || item.banner_url || '', item.preview_url || item.image_url || '',
               JSON.stringify(metadata),
               item.is_active !== false, mapper.sortOrder(item) || 0,
               item.created_at || new Date(), item.updated_at || item.created_at || new Date()]
            );
            migrated++;
          }
          results.push({ table: tableName, migrated });
        } catch (e) { results.push({ table: tableName, error: e.message }); }
      };

      /** Generate a fallback slug for migration */
      function migrationSlug(name) {
        let s = generateSlug(name || 'migrated-item');
        return s || `migrated-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      }

      // Migrate cosmetics
      await migrateTable('cosmetics', 'cosmetic', {
        slug: item => item.slug,
        metadata: item => ({ cosmeticType: item.type || 'cape', rarity: item.rarity || 'common', accentColor: item.accent_color || '', modelUrl: item.model_url || '' }),
        category: item => item.slug?.split('-')[0] || 'general',
        tags: () => ['cosmetic'],
        sortOrder: item => item.sort_order,
      });

      // Migrate news
      await migrateTable('news', 'news', {
        slug: item => migrationSlug(item.title),
        metadata: item => ({ subtitle: item.subtitle || '', content: item.content || '', author: item.author || 'Bamboo Team', publishedAt: item.published_at ? new Date(item.published_at).toISOString() : null, isPinned: item.is_pinned || false, gameVersion: item.game_version || '' }),
        category: item => item.category || 'general',
        tags: item => item.tags || [],
        sortOrder: item => item.sort_order,
      });

      // Migrate events
      await migrateTable('events', 'event', {
        slug: item => migrationSlug(item.title),
        metadata: item => ({ subtitle: item.subtitle || '', description: item.description || '', startDate: item.start_date ? new Date(item.start_date).toISOString() : null, endDate: item.end_date ? new Date(item.end_date).toISOString() : null, priority: item.priority || 0, author: item.author || 'Bamboo Team', isActive: item.is_active !== false }),
        category: item => item.category || 'general',
        tags: () => ['event'],
        sortOrder: () => 0,
      });

      // Migrate banners
      await migrateTable('banners', 'banner', {
        slug: item => migrationSlug(item.title),
        metadata: item => ({ clickTarget: item.click_target || '', clickType: item.click_type || 'external', priority: item.priority || 0, description: item.description || '' }),
        category: () => 'general',
        tags: () => ['banner'],
        sortOrder: item => item.sort_order,
      });

      return res.json({ success: true, results, message: 'Migration completed. Check results for details.' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === POST /api/content/:type/:id/assign-files — Assign files to a content item
  // ====================================================================
  app.post('/api/content/:type/:id/assign-files', authenticateAdmin, async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });

      const assetType = validateType(req.params.type);
      if (!assetType) return res.status(400).json({ error: 'Invalid content type' });

      const asset = await pool.query('SELECT * FROM assets WHERE id = $1 AND asset_type = $2', [req.params.id, assetType]);
      if (!asset.rows.length) return res.status(404).json({ error: 'Content not found' });
      const item = asset.rows[0];

      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'files array required' });
      }

      const assigned = [];
      for (const f of files) {
        const { filePath, fileType, fileName } = f;
        if (!filePath) continue;

        const fullPath = path.join(CONTENT_ROOT, filePath);
        let hash = '', size = 0;
        if (fs.existsSync(fullPath)) {
          try {
            const stat = fs.statSync(fullPath);
            size = stat.size;
            hash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
          } catch {}
        }

        const safeName = fileName || path.basename(filePath);
        const detectedType = fileType || guessFileType(safeName);
        const fileId = uuidv4();

        try {
          await pool.query(
            `INSERT INTO asset_files (id, asset_id, file_path, file_name, file_type, file_hash, file_size, disk_path)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (asset_id, file_name) DO UPDATE SET
               file_path = EXCLUDED.file_path, file_type = EXCLUDED.file_type,
               file_hash = EXCLUDED.file_hash, file_size = EXCLUDED.file_size,
               disk_path = EXCLUDED.disk_path, updated_at = NOW()
             RETURNING *`,
            [fileId, item.id, filePath, safeName, detectedType, hash, size, fullPath]
          );
          assigned.push({ filePath, fileName: safeName, fileType: detectedType, fileSize: size });
        } catch (err) {
          console.warn('[content] Could not assign file:', err.message);
        }
      }

      // Auto-set thumbnail from first image
      if (!item.thumbnail_url) {
        const imageFile = files.find(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f.filePath));
        if (imageFile) {
          await pool.query('UPDATE assets SET thumbnail_url = $1, updated_at = NOW() WHERE id = $2', [imageFile.filePath, item.id]);
        }
      }

      return res.json({ success: true, files: assigned, count: assigned.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === DELETE /api/content/files/:assetId/:fileId — Remove file from asset
  // ====================================================================
  app.delete('/api/content/files/:assetId/:fileId', authenticateAdmin, async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
      const r = await pool.query('DELETE FROM asset_files WHERE id = $1 AND asset_id = $2 RETURNING *', [req.params.fileId, req.params.assetId]);
      if (!r.rows.length) return res.status(404).json({ error: 'File not found' });
      return res.json({ success: true, removed: r.rows[0].file_name });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === GET /api/content — List all content types with counts =========
  // ====================================================================
  app.get('/api/content', async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });

      const r = await pool.query(
        `SELECT asset_type, COUNT(*) as count,
         COUNT(*) FILTER (WHERE status = 'draft') as draft_count,
         COUNT(*) FILTER (WHERE status = 'published') as published_count
         FROM assets GROUP BY asset_type ORDER BY asset_type`
      );

      const types = [];
      const typeNames = {
        cosmetic: 'Cosmetics', news: 'News & Announcements', event: 'Events',
        banner: 'Banners', theme: 'Themes',
        icon: 'Icons', ui_asset: 'UI Assets', music: 'Music',
        shader: 'Shaders', resource_pack: 'Resource Packs', font: 'Fonts', other: 'Other',
      };
      const typeIcons = {
        cosmetic: 'sparkles', news: 'newspaper', event: 'calendar', banner: 'image',
        theme: 'palette', icon: 'file', ui_asset: 'package',
        music: 'music', shader: 'code', resource_pack: 'box', font: 'type', other: 'folder',
      };

      for (const row of r.rows) {
        // Skip deprecated 'background' type (now part of themes)
        if (row.asset_type === 'background') continue;
        types.push({
          type: row.asset_type,
          name: typeNames[row.asset_type] || row.asset_type,
          icon: typeIcons[row.asset_type] || 'package',
          count: parseInt(row.count),
          draftCount: parseInt(row.draft_count),
          publishedCount: parseInt(row.published_count),
        });
      }

      return res.json({ data: types });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
};
