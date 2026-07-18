// ======================================================================
// === ASSET MANAGEMENT API (Phase 3) ====================================
// ======================================================================

module.exports = function assetRoutes(app, ctx) {
  const { pool, dbConnected, authenticateAdmin, uuidv4 } = ctx;

  function mapAssetRow(r) {
    return {
      id: r.id, slug: r.slug, name: r.name, description: r.description || '',
      assetType: r.asset_type, category: r.category || 'general',
      status: r.status, version: r.version, tags: r.tags || [],
      thumbnailUrl: r.thumbnail_url || '', previewUrl: r.preview_url || '',
      metadata: r.metadata || {}, isActive: r.is_active, sortOrder: r.sort_order || 0,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
    };
  }

  function mapAssetFileRow(r) {
    return {
      id: r.id, assetId: r.asset_id, filePath: r.file_path, fileName: r.file_name,
      fileType: r.file_type, fileHash: r.file_hash, fileSize: r.file_size,
      mimeType: r.mime_type || 'application/octet-stream', diskPath: r.disk_path || '',
      sortOrder: r.sort_order || 0,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
    };
  }

  // GET /api/assets — List all assets with search, filter, sort
  app.get('/api/assets', authenticateAdmin, async (req, res) => {
    try {
      if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
      const { search, assetType, category, status, page = 1, limit = 50, sortBy = 'updatedAt', sortDir = 'desc' } = req.query;
      const off = (parseInt(page) - 1) * parseInt(limit);
      let q = 'SELECT * FROM assets WHERE 1=1'; const p = []; let i = 1;
      if (search) { q += ` AND (name ILIKE $${i} OR description ILIKE $${i} OR slug ILIKE $${i})`; p.push(`%${search}%`); i++; }
      if (assetType && assetType !== 'all') { q += ` AND asset_type=$${i++}`; p.push(assetType); }
      if (category && category !== 'all') { q += ` AND category=$${i++}`; p.push(category); }
      if (status && status !== 'all') { q += ` AND status=$${i++}`; p.push(status); }
      const sortCols = { name: 'name', type: 'asset_type', status: 'status', version: 'version', updated: 'updated_at', created: 'created_at' };
      const sortCol = sortCols[sortBy] || 'updated_at';
      const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
      q += ` ORDER BY ${sortCol} ${dir}`;
      const cq = q.replace('SELECT *', 'SELECT COUNT(*)').split('ORDER BY')[0];
      q += ` LIMIT $${i++} OFFSET $${i++}`; p.push(parseInt(limit), off);
      const [r, cr] = await Promise.all([pool.query(q, p), pool.query(cq, p.slice(0, -2))]);
      const assets = [];
      for (const row of r.rows) {
        const fc = await pool.query('SELECT COUNT(*) FROM asset_files WHERE asset_id=$1', [row.id]);
        assets.push({ ...mapAssetRow(row), fileCount: parseInt(fc.rows[0].count) });
      }
      return res.json({ data: assets, total: parseInt(cr.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  // GET /api/assets/stats — Asset statistics
  app.get('/api/assets/stats', authenticateAdmin, async (req, res) => {
    try {
      if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
      const [total, byType, byStatus] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM assets'),
        pool.query('SELECT asset_type, COUNT(*) as count FROM assets GROUP BY asset_type ORDER BY count DESC'),
        pool.query('SELECT status, COUNT(*) as count FROM assets GROUP BY status ORDER BY count DESC'),
      ]);
      return res.json({ total: parseInt(total.rows[0].count), byType: byType.rows, byStatus: byStatus.rows });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  // GET /api/assets/categories — List distinct categories
  app.get('/api/assets/categories', authenticateAdmin, async (req, res) => {
    try {
      if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
      const r = await pool.query('SELECT DISTINCT category FROM assets ORDER BY category');
      return res.json(r.rows.map(x => x.category));
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  // GET /api/assets/:id — Get single asset with files
  app.get('/api/assets/:id', authenticateAdmin, async (req, res) => {
    try {
      if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
      const r = await pool.query('SELECT * FROM assets WHERE id=$1', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Asset not found' });
      const files = await pool.query('SELECT * FROM asset_files WHERE asset_id=$1 ORDER BY sort_order, file_name', [req.params.id]);
      return res.json({ ...mapAssetRow(r.rows[0]), files: files.rows.map(mapAssetFileRow) });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  // POST /api/assets — Create new asset
  app.post('/api/assets', authenticateAdmin, async (req, res) => {
    try {
      if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
      const { slug, name, description, assetType, category, status, tags, thumbnailUrl, previewUrl, metadata } = req.body;
      if (!slug || !name) return res.status(400).json({ error: 'Slug and name required' });
      if (typeof slug !== 'string' || slug.length > 128) return res.status(400).json({ error: 'Slug must be 1-128 characters' });
      if (typeof name !== 'string' || name.length > 256) return res.status(400).json({ error: 'Name must be 1-256 characters' });
      const ALLOWED_ASSET_TYPES = ['cosmetic','theme','background','icon','ui_asset','music','shader','resource_pack','font','other'];
      if (assetType && !ALLOWED_ASSET_TYPES.includes(assetType)) return res.status(400).json({ error: 'Invalid asset type' });
      const ALLOWED_STATUSES = ['draft','published','archived'];
      if (status && !ALLOWED_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
      const id = uuidv4();
      try {
        const r = await pool.query(
          'INSERT INTO assets (id,slug,name,description,asset_type,category,status,tags,thumbnail_url,preview_url,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
          [id, slug, name, description || '', assetType || 'other', category || 'general', status || 'draft', tags || [], thumbnailUrl || '', previewUrl || '', JSON.stringify(metadata || {})]
        );
        return res.status(201).json(mapAssetRow(r.rows[0]));
      } catch (pgErr) {
        if (pgErr.code === '23505') return res.status(409).json({ error: 'Asset with this slug already exists' });
        throw pgErr;
      }
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  // PUT /api/assets/:id — Update asset
  app.put('/api/assets/:id', authenticateAdmin, async (req, res) => {
    try {
      if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
      const ex = await pool.query('SELECT * FROM assets WHERE id=$1', [req.params.id]);
      if (!ex.rows.length) return res.status(404).json({ error: 'Asset not found' });
      const { slug, name, description, assetType, category, status, version, tags, thumbnailUrl, previewUrl, metadata, isActive, sortOrder } = req.body;
      const r = await pool.query(
        'UPDATE assets SET slug=COALESCE($2,slug),name=COALESCE($3,name),description=COALESCE($4,description),asset_type=COALESCE($5,asset_type),category=COALESCE($6,category),status=COALESCE($7,status),version=COALESCE($8,version),tags=COALESCE($9,tags),thumbnail_url=COALESCE($10,thumbnail_url),preview_url=COALESCE($11,preview_url),metadata=COALESCE($12,metadata),is_active=COALESCE($13,is_active),sort_order=COALESCE($14,sort_order),updated_at=NOW() WHERE id=$1 RETURNING *',
        [req.params.id, slug, name, description, assetType, category, status, version, tags, thumbnailUrl, previewUrl, metadata ? JSON.stringify(metadata) : null, isActive !== undefined ? isActive : null, sortOrder]
      );
      return res.json(mapAssetRow(r.rows[0]));
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  // DELETE /api/assets/:id — Delete asset (cascades to files)
  app.delete('/api/assets/:id', authenticateAdmin, async (req, res) => {
    try {
      if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
      const r = await pool.query('DELETE FROM assets WHERE id=$1 RETURNING id', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Asset not found' });
      return res.json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  // PATCH /api/assets/:id/toggle — Toggle active
  app.patch('/api/assets/:id/toggle', authenticateAdmin, async (req, res) => {
    try {
      if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
      const r = await pool.query('UPDATE assets SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 RETURNING *', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Asset not found' });
      return res.json(mapAssetRow(r.rows[0]));
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  // PATCH /api/assets/:id/status — Change status
  app.patch('/api/assets/:id/status', authenticateAdmin, async (req, res) => {
    try {
      if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
      const { status } = req.body;
      if (!['draft','published','archived'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
      const r = await pool.query('UPDATE assets SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [req.params.id, status]);
      if (!r.rows.length) return res.status(404).json({ error: 'Asset not found' });
      return res.json(mapAssetRow(r.rows[0]));
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  // POST /api/assets/:id/files — Add/manage files for an asset
  app.post('/api/assets/:id/files', authenticateAdmin, async (req, res) => {
    try {
      if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
      const ex = await pool.query('SELECT * FROM assets WHERE id=$1', [req.params.id]);
      if (!ex.rows.length) return res.status(404).json({ error: 'Asset not found' });
      const { fileName, filePath, fileType, fileHash, fileSize, mimeType, diskPath } = req.body;
      if (!fileName) return res.status(400).json({ error: 'fileName required' });
      const id = uuidv4();
      try {
        const r = await pool.query(
          'INSERT INTO asset_files (id,asset_id,file_path,file_name,file_type,file_hash,file_size,mime_type,disk_path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (asset_id, file_name) DO UPDATE SET file_path=EXCLUDED.file_path,file_type=EXCLUDED.file_type,file_hash=EXCLUDED.file_hash,file_size=EXCLUDED.file_size,mime_type=EXCLUDED.mime_type,disk_path=EXCLUDED.disk_path,updated_at=NOW() RETURNING *',
          [id, req.params.id, filePath || fileName, fileName, fileType || 'other', fileHash || '', fileSize || 0, mimeType || 'application/octet-stream', diskPath || '']
        );
        return res.status(201).json(mapAssetFileRow(r.rows[0]));
      } catch (pgErr) {
        if (pgErr.code === '23505') return res.status(409).json({ error: 'File already exists in asset' });
        throw pgErr;
      }
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });

  // DELETE /api/assets/:id/files/:fileId — Remove file from asset
  app.delete('/api/assets/:id/files/:fileId', authenticateAdmin, async (req, res) => {
    try {
      if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
      const r = await pool.query('DELETE FROM asset_files WHERE id=$1 AND asset_id=$2 RETURNING id', [req.params.fileId, req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'File not found' });
      return res.json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  });
};
