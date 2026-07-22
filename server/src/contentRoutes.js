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
  // Local filesystem path for the content repo (if cloned locally)
  const CONTENT_ROOT = process.env.BAMBOO_CONTENT_REPO || (
    process.env.NODE_ENV === 'production'
      ? '/tmp/bamboo-content'
      : path.resolve(__dirname, '..', '..', '..', 'BambooContent')
  );
  // ====================================================================
  // === REPOSITORY CACHE ===============================================
  // Der Repository-Cache lädt den Dateibaum GENAU EINMAL von GitHub
  // und arbeitet dann ausschließlich aus dem RAM.
  // Navigation, Filter, Suche — KEIN neuer GitHub Request.
  // Nur bei Serverstart, manuellem Refresh oder alle 5 Minuten wird
  // der Cache aktualisiert.
  // Bei GitHub-Fehlern wird der letzte gültige Cache weiter verwendet.
  // ====================================================================
  const GITHUB_CONTENT_REPO = process.env.GITHUB_CONTENT_REPO || 'Borisgamer1/Bamboo-Launcher---Content';
  const GITHUB_CONTENT_BRANCH = process.env.GITHUB_CONTENT_BRANCH || 'main';
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

  if (GITHUB_TOKEN) {
    console.log('[Repo] GitHub Token gefunden — Rate Limit: 5000 Requests/h');
  } else {
    console.warn('[Repo] Kein GitHub Token gesetzt — Rate Limit: 60 Requests/h');
    console.warn('[Repo] Setze GITHUB_TOKEN als Environment Variable für höheres Limit');
  }

  const _repoCache = {
    files: [],         // Alle Dateien (flache Liste)
    dirs: [],          // Alle Verzeichnisse (flache Liste)
    status: 'initializing', // 'connected' | 'cached' | 'error'
    lastSync: null,    // Timestamp des letzten erfolgreichen Syncs
    lastError: null,   // Letzter Fehler
    errorCount: 0,     // Zähler für aufeinanderfolgende Fehler
    totalFiles: 0,     // Gesamtanzahl Dateien
    totalDirs: 0,      // Gesamtanzahl Verzeichnisse
  };
  let _cacheTimer = null;

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
      case 'cosmetic': {
        const meta = row.metadata || {};
        const validUnlockTypes = ['free','playtime','achievement','rank','event','server','code'];
        // Prefer Phase 5 nested shape: meta.unlock = {type, requirements[]}
        // Fall back to legacy flat fields ONLY when the new shape is missing.
        const modelFormat = (typeof meta.modelFormat === 'string') ? meta.modelFormat : null;
        const validCategories = ['cape','aura','hat','ear','wings','rank','other'];
        const category = validCategories.includes(meta.cosmeticType) ? meta.cosmeticType : (validCategories.includes(meta.category) ? meta.category : 'cape');
        const validRarities = ['common','rare','epic','legendary','mythic'];
        const rarity = validRarities.includes(meta.rarity) ? meta.rarity : 'common';
        return {
          ...base,
          type: category,
          category,
          rarity,
          imageUrl: row.thumbnail_url || row.preview_url || '',
          modelUrl: (meta.modelUrl) || '',
    
          metadata: {
            category,
            rarity,
            modelFormat,
          },
        };
      }
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

  // ====================================================================
  // === REPOSITORY CACHE FUNKTIONEN =====================================
  // ====================================================================

  /** GitHub API mit optionalem Token aufrufen */
  function githubFetch(url) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const headers = { 'User-Agent': 'Bamboo-Launcher/1.0' };
      if (GITHUB_TOKEN) headers.Authorization = 'Bearer ' + GITHUB_TOKEN;

      let timer = setTimeout(() => {
        req.destroy();
        const tErr = new Error('GitHub API request timed out after 15s');
        tErr.code = 'ETIMEDOUT';
        reject(tErr);
      }, 15000);

      const req = https.get(url, { headers }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('Invalid JSON from GitHub: ' + e.message)); }
          } else {
            reject(new Error('GitHub API returned ' + res.statusCode + ': ' + body.substring(0, 200)));
          }
        });
      });
      req.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  /** Rohdaten von GitHub in unser Datei-/Ordner-Format konvertieren */
  function convertGithubTree(data) {
    if (!data.tree || !Array.isArray(data.tree)) {
      throw new Error('GitHub API response missing tree array');
    }

    const files = data.tree
      .filter(item => item.type === 'blob')
      .map(item => {
        const fullPath = item.path.replace(/\\/g, '/');
        return {
          name: fullPath.split('/').pop(),
          path: fullPath,
          type: 'file',
          size: item.size || 0,
          sha: item.sha,
          mtime: new Date().toISOString(),
        };
      });

    const dirMap = new Map();
    for (const item of files) {
      const parts = item.path.split('/');
      if (parts.length > 1) {
        for (let i = 1; i < parts.length; i++) {
          const dirPath = parts.slice(0, i).join('/');
          if (!dirMap.has(dirPath)) {
            dirMap.set(dirPath, { name: parts[i-1], path: dirPath, type: 'directory', fileCount: 0 });
          }
        }
      }
    }
    for (const item of files) {
      const slash = item.path.lastIndexOf('/');
      if (slash >= 0) {
        const parent = item.path.substring(0, slash);
        if (dirMap.has(parent)) dirMap.get(parent).fileCount++;
      }
    }

    return { files, dirs: Array.from(dirMap.values()) };
  }

  /** Cache aus GitHub neu laden (wird von Serverstart, Refresh-Button und Timer aufgerufen) */
  async function refreshRepoCache() {
    const url = `https://api.github.com/repos/${GITHUB_CONTENT_REPO}/git/trees/${GITHUB_CONTENT_BRANCH}?recursive=1`;

    try {
      console.log('[Repo] Loading repository...');
      const data = await githubFetch(url);
      const converted = convertGithubTree(data);

      _repoCache.files = converted.files;
      _repoCache.dirs = converted.dirs;
      _repoCache.status = 'connected';
      _repoCache.lastSync = new Date().toISOString();
      _repoCache.lastError = null;
      _repoCache.errorCount = 0;
      _repoCache.totalFiles = converted.files.length;
      _repoCache.totalDirs = converted.dirs.length;

      console.log(`[Repo] Loaded ${converted.files.length} files, ${converted.dirs.length} directories`);
      return true;
    } catch (err) {
      const hadData = _repoCache.files.length > 0;
      _repoCache.status = hadData ? 'cached' : 'error';
      _repoCache.lastError = { message: err.message, code: err.code, time: new Date().toISOString() };
      _repoCache.errorCount++;

      if (hadData) {
        console.log(`[Repo] GitHub request failed — using cached repository (${_repoCache.files.length} files)`);
      } else {
        console.error('[Repo] GitHub request failed — no cache available');
        console.error(err.stack);
      }
      return false;
    }
  }

  /** Automatischen Refresh-Timer starten (alle 5 Minuten) */
  function startCacheTimer() {
    if (_cacheTimer) clearInterval(_cacheTimer);
    _cacheTimer = setInterval(async () => {
      console.log('[Repo] Auto-refresh (5 min interval)');
      await refreshRepoCache();
    }, 5 * 60 * 1000);
  }

  /** Initialen Cache-Laden beim Serverstart */
  (async () => {
    await refreshRepoCache();
    startCacheTimer();
  })();

  // ===== GET /api/content/status — Cache-Status (ohne GitHub-Request) =====
  app.get('/api/content/status', authenticateAdmin, async (req, res) => {
    const age = _repoCache.lastSync ? (Date.now() - new Date(_repoCache.lastSync).getTime()) / 1000 : null;
    return res.json({
      success: true,
      status: _repoCache.status,
      totalFiles: _repoCache.totalFiles,
      totalDirs: _repoCache.totalDirs,
      lastSync: _repoCache.lastSync,
      lastError: _repoCache.lastError,
      errorCount: _repoCache.errorCount,
      cacheAgeSeconds: age,
      repo: GITHUB_CONTENT_REPO,
      branch: GITHUB_CONTENT_BRANCH,
      hasToken: !!GITHUB_TOKEN,
    });
  });

  // ===== POST /api/content/refresh — Cache manuell neu laden =========
  app.post('/api/content/refresh', authenticateAdmin, async (req, res) => {
    console.log('[Repo] Manual refresh requested');
    const ok = await refreshRepoCache();
    if (ok) {
      return res.json({
        success: true,
        status: _repoCache.status,
        totalFiles: _repoCache.totalFiles,
        totalDirs: _repoCache.totalDirs,
        lastSync: _repoCache.lastSync,
        message: `Repository loaded: ${_repoCache.totalFiles} files, ${_repoCache.totalDirs} directories`,
      });
    } else if (_repoCache.files.length > 0) {
      return res.json({
        success: true,
        status: 'cached',
        totalFiles: _repoCache.totalFiles,
        totalDirs: _repoCache.totalDirs,
        lastSync: _repoCache.lastSync,
        lastError: _repoCache.lastError,
        message: `GitHub request failed — using cached repository (${_repoCache.files.length} files)`,
      });
    } else {
      return res.status(502).json({
        success: false,
        error: 'GitHub is not reachable and no cache available.',
        detail: _repoCache.lastError,
      });
    }
  });

  // ===== GET /api/content/debug — Server-Status & Diagnose ==========
  // Zeigt den aktuellen Commit, Build-Zeit, NODE_ENV, Repository-Info,
  // GitHub API Status, Cache-Status und Datei-Statistiken.
  // Authentifizierung erforderlich (sonst könnte jeder die Konfiguration sehen).
  app.get('/api/content/debug', authenticateAdmin, async (req, res) => {
    try {
      // Try to get commit hash
      let commitHash = 'unknown';
      let commitMessage = '';
      try {
        const { execSync } = require('child_process');
        commitHash = execSync('git rev-parse HEAD', { cwd: path.resolve(__dirname, '..'), timeout: 3000 }).toString().trim();
        commitMessage = execSync('git log --oneline -1', { cwd: path.resolve(__dirname, '..'), timeout: 3000 }).toString().trim();
      } catch { /* not a git repo or git not available */ }

      // Check local content root
      let localFiles = 0;
      let localDirs = 0;
      try {
        if (fs.existsSync(CONTENT_ROOT)) {
          const entries = fs.readdirSync(CONTENT_ROOT, { withFileTypes: true });
          for (const e of entries) {
            if (e.name === '.git' || e.name === 'node_modules') continue;
            if (e.isDirectory()) localDirs++;
            else localFiles++;
          }
        }
      } catch {}

      const cacheAge = _repoCache.lastSync ? (Date.now() - new Date(_repoCache.lastSync).getTime()) / 1000 : null;
      const buildTime = new Date().toISOString();

      return res.json({
        success: true,
        server: {
          buildTime,
          nodeEnv: process.env.NODE_ENV || 'not set',
          nodeVersion: process.version,
          platform: process.platform,
        },
        version: {
          commit: commitHash,
          commitMessage: commitMessage,
        },
        github: {
          repository: GITHUB_CONTENT_REPO,
          branch: GITHUB_CONTENT_BRANCH,
          hasToken: !!GITHUB_TOKEN,
        },
        cache: {
          status: _repoCache.status,
          fileCount: _repoCache.totalFiles,
          dirCount: _repoCache.totalDirs,
          ageSeconds: cacheAge,
          lastSync: _repoCache.lastSync,
          lastError: _repoCache.lastError,
          errorCount: _repoCache.errorCount,
        },
        filesystem: {
          contentRoot: CONTENT_ROOT,
          exists: fs.existsSync(CONTENT_ROOT),
          localFiles: localFiles,
          localDirs: localDirs,
        },
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

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
  // Liest ausschließlich aus dem Repository-Cache (RAM).
  // KEIN direkter GitHub API Call — der Cache wird nur beim Serverstart,
  // bei manuellem Refresh oder alle 5 Minuten aktualisiert.
  // Fallback bei leerem Cache: lokales Dateisystem (für lokale Entwicklung).
  app.get('/api/content/files', authenticateAdmin, async (req, res) => {
    const start = Date.now();

    try {
      const subDir = (req.query.dir || '').replace(/\\\\/g, '/').replace(/\.\./g, '');
      const searchQuery = (req.query.q || '').trim().toLowerCase();
      const typeFilter = (req.query.type || 'all').toLowerCase();
      const page = Math.max(1, parseInt(req.query.page || '1'));
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50')));

      const typeMatch = {
        image: f => /\.(png|jpg|jpeg|webp|gif|svg|ico)$/i.test(f),
        model: f => /\.(glb|gltf|bbmodel|json)$/i.test(f),
        audio: f => /\.(mp3|ogg|wav)$/i.test(f),
        json: f => /\.json$/i.test(f),
        font: f => /\.(ttf|otf|woff2)$/i.test(f),
        archive: f => /\.zip$/i.test(f),
        texture: f => /\.(png)$/i.test(f),
        glb: f => /\.(glb|gltf|bbmodel|json)$/i.test(f),
        icon: f => /\.(png|jpg|jpeg|webp|gif|svg|ico)$/i.test(f),
      };

      let allItems = [];
      let source = 'cache';

      // ---- Aus Repository-Cache lesen ----
      if (_repoCache.files.length > 0 || _repoCache.dirs.length > 0) {
        if (searchQuery) {
          allItems.push(
            ..._repoCache.files
              .filter(f => f.path.toLowerCase().includes(searchQuery))
              .map(f => ({ name: f.name, path: f.path, type: 'file', size: f.size, mtime: f.mtime }))
          );
        } else if (subDir) {
          const prefix = subDir + '/';
          allItems.push(
            ..._repoCache.dirs
              .filter(d => d.path === subDir || (d.path.startsWith(prefix) && !d.path.substring(prefix.length).includes('/')))
              .map(d => ({ name: d.name, path: d.path, type: 'directory', fileCount: d.fileCount }))
          );
          allItems.push(
            ..._repoCache.files
              .filter(f => f.path.startsWith(prefix) && !f.path.substring(prefix.length).includes('/'))
              .map(f => ({ name: f.name, path: f.path, type: 'file', size: f.size, mtime: f.mtime }))
          );
        } else {
          const topLevelDirs = _repoCache.dirs.filter(d => !d.path.includes('/'));
          const topLevelFiles = _repoCache.files.filter(f => !f.path.includes('/'));
          allItems.push(...topLevelDirs.map(d => ({ name: d.name, path: d.path, type: 'directory', fileCount: d.fileCount })));
          allItems.push(...topLevelFiles.map(f => ({ name: f.name, path: f.path, type: 'file', size: f.size, mtime: f.mtime })));
        }

        allItems.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      }

      // ---- Fallback: lokales Dateisystem (für lokale Entwicklung) ----
      if (allItems.length === 0 && fs.existsSync(CONTENT_ROOT)) {
        source = 'filesystem';
        const browsePath = subDir ? path.join(CONTENT_ROOT, subDir) : CONTENT_ROOT;
        const resolved = path.resolve(browsePath);
        const resolvedRoot = path.resolve(CONTENT_ROOT);

        if (resolved.startsWith(resolvedRoot) && fs.existsSync(browsePath)) {
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
      }

      // ---- Wenn immer noch leer, Fehler nur wenn Cache nie geladen wurde ----
      if (allItems.length === 0 && _repoCache.status === 'initializing') {
        return res.status(503).json({
          success: false,
          error: 'Repository wird geladen. Bitte versuche es in einigen Sekunden erneut.',
          cacheStatus: 'initializing',
        });
      }

      // ---- Type-Filter anwenden ----
      if (typeFilter !== 'all' && typeMatch[typeFilter]) {
        allItems = allItems.filter(i => i.type === 'directory' || typeMatch[typeFilter](i.name));
      }

      // ---- Paginieren ----
      const total = allItems.length;
      const offset = (page - 1) * limit;
      const items = allItems.slice(offset, offset + limit);
      const parentDir = subDir ? subDir.split('/').slice(0, -1).join('/') : null;

      return res.json({
        success: true,
        source,
        path: subDir || '/',
        parentDir: parentDir || null,
        items,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error('[files] Unhandled error:', err.message);
      console.error(err.stack);
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== GET /api/content/files/preview — Get file preview data =======
  // Returns file metadata. For images, includes a serve URL for the browser.
  // Tries local filesystem first, falls back to GitHub raw content.
  app.get('/api/content/files/preview', authenticateAdmin, async (req, res) => {
    try {
      const filePath = (req.query.path || '').replace(/\\\\/g, '/').replace(/\.\./g, '');
      if (!filePath) return res.status(400).json({ error: 'File path required' });

      const fullPath = path.join(CONTENT_ROOT, filePath);
      const ext = path.extname(filePath).toLowerCase();
      const isImage = /^\.(png|jpg|jpeg|webp|gif|svg|ico)$/i.test(ext);

      const preview = {
        name: path.basename(filePath),
        path: filePath,
        ext,
        isImage,
        // URL for binary serving (works with local filesystem AND GitHub)
        url: `/api/content/files/serve?path=${encodeURIComponent(filePath)}`,
      };

      // Try local filesystem first
      const resolved = path.resolve(fullPath);
      const resolvedRoot = path.resolve(CONTENT_ROOT);
      let hasLocal = false;
      if (resolved.startsWith(resolvedRoot) && fs.existsSync(fullPath)) {
        try {
          const stat = fs.statSync(fullPath);
          preview.size = stat.size;
          preview.mtime = stat.mtime.toISOString();
          hasLocal = true;

          if (isImage && stat.size < 1024 * 1024) {
            const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
            preview.mimeType = mimeMap[ext] || 'image/png';
            const data = fs.readFileSync(fullPath);
            preview.base64 = `data:${preview.mimeType};base64,${data.toString('base64')}`;
            preview.source = 'filesystem';
          }
        } catch {}
      }

      if (!hasLocal) {
        preview.source = 'github';
        // Size info from GitHub API is available via the file list, not here
        preview.size = 0;
      }

      return res.json({ success: true, data: preview });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== GET /api/content/files/serve — Direct file serving ===========
  // PRIMARY: proxies from raw.githubusercontent.com (public repo, no auth needed).
  // FALLBACK: reads from local filesystem when GitHub is unavailable.
  app.get('/api/content/files/serve', authenticateAdmin, async (req, res) => {
    try {
      const filePath = (req.query.path || '').replace(/\\\\/g, '/').replace(/\.\./g, '');
      if (!filePath) return res.status(400).json({ error: 'File path required' });

      // ---- STEP 1: Try local filesystem first ----
      const fullPath = path.join(CONTENT_ROOT, filePath);
      const resolved = path.resolve(fullPath);
      const resolvedRoot = path.resolve(CONTENT_ROOT);
      if (resolved.startsWith(resolvedRoot)) {
        if (fs.existsSync(fullPath)) {
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
          return;
        }
      }

      // ---- STEP 2: Fall back to GitHub raw content ----
      const githubUrl = `https://raw.githubusercontent.com/${GITHUB_CONTENT_REPO}/${GITHUB_CONTENT_BRANCH}/${filePath}`;
      console.log('[content] Proxying file from GitHub:', githubUrl);
      try {
        const https = require('https');
        const ghReq = https.get(githubUrl, { headers: { 'User-Agent': 'Bamboo-Launcher/1.0' } }, (ghRes) => {
          if (ghRes.statusCode === 200) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeMap = {
              '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
              '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
              '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
              '.bbmodel': 'application/octet-stream',
            };
            res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            ghRes.pipe(res);
          } else if (ghRes.statusCode === 404) {
            return res.status(404).json({ error: 'File not found in repository' });
          } else {
            return res.status(ghRes.statusCode).json({ error: 'GitHub error: ' + ghRes.statusCode });
          }
        });
        ghReq.on('error', (err) => {
          return res.status(502).json({ error: 'GitHub proxy error: ' + err.message });
        });
      } catch (err) {
        return res.status(502).json({ error: 'GitHub proxy error: ' + err.message });
      }
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
        if (req.body.unlock && typeof req.body.unlock === 'object') {
          mergedMetadata.unlock = req.body.unlock;
          mergedMetadata.unlockType = req.body.unlock.type || 'free';
          mergedMetadata.unlockRequirements = req.body.unlock.requirements || [];
        }
        if (req.body.treeNodeId) {
          mergedMetadata.treeNodeId = req.body.treeNodeId;
        }
        if (req.body.rarity) mergedMetadata.rarity = req.body.rarity;

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
        if (req.body.unlock && typeof req.body.unlock === 'object') {
          mergedMeta.unlock = req.body.unlock;
          mergedMeta.unlockType = req.body.unlock.type || 'free';
          mergedMeta.unlockRequirements = req.body.unlock.requirements || [];
        }
        if (req.body.treeNodeId) {
          mergedMeta.treeNodeId = req.body.treeNodeId;
        }
        if (req.body.rarity !== undefined) mergedMeta.rarity = req.body.rarity;

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

  // ====================================================================
  
  // === GET /api/content/files/:fileId/download - Download content file ===
  // ====================================================================
  // Serves ANY content file directly from disk by its asset_files ID.
  app.get('/api/content/files/:fileId/download', async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
      const fileId = req.params.fileId;
      if (!fileId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) return res.status(400).json({ error: 'Invalid file ID: expected UUID' });
      const files = await pool.query('SELECT * FROM asset_files WHERE id = $1', [fileId]);
      if (!files.rows.length) return res.status(404).json({ error: 'File not found in database' });
      var frow = files.rows[0];
      var diskPath = frow.disk_path || path.join(CONTENT_ROOT, frow.file_path);
      if (!diskPath || !fs.existsSync(diskPath)) return res.status(404).json({ error: 'File not found on disk: ' + diskPath });
      console.log('[content] Serving file download:', diskPath, '(' + (frow.file_name || 'unknown') + ')');
      return res.sendFile(path.resolve(diskPath));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // === GET /api/content/:type/:id/model — Serve 3D model file =======
  // ====================================================================
  app.get('/api/content/:type/:id/model', async (req, res) => {
    try {
      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });
      const assetType = validateType(req.params.type);
      if (!assetType) return res.status(400).json({ error: 'Invalid content type' });
      const r = await pool.query('SELECT * FROM assets WHERE (slug = $1 OR id::text = $1) AND asset_type = $2', [req.params.id, assetType]);
      if (!r.rows.length) return res.status(404).json({ error: 'Content not found' });
      // Find first model file (.json, .glb, .gltf, .bbmodel)
      const files = await pool.query(
        "SELECT * FROM asset_files WHERE asset_id = $1 AND (file_type = 'model' OR file_name ~ '.(json|glb|gltf|bbmodel)$') ORDER BY sort_order LIMIT 1",
        [r.rows[0].id]
      );
      if (!files.rows.length) return res.status(404).json({ error: 'No model file found' });
      var diskPath = files.rows[0].disk_path || path.join(CONTENT_ROOT, files.rows[0].file_path);
      if (!diskPath || !fs.existsSync(diskPath)) return res.status(404).json({ error: 'Model file not found on disk' });
      console.log('[content] Serving model:', diskPath);
      return res.sendFile(path.resolve(diskPath));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // === GET /api/content/:type/:id/image — Serve content image =======
  // ====================================================================
  app.get('/api/content/:type/:id/image', async (req, res) => {
    try {
      const assetType = validateType(req.params.type);
      if (!assetType) return res.status(400).json({ error: 'Invalid content type' });

      const r = await pool.query('SELECT slug, thumbnail_url, preview_url, metadata FROM assets WHERE (slug = $1 OR id::text = $1) AND asset_type = $2', [req.params.id, assetType]);
      if (!r.rows.length) return res.status(404).json({ error: 'Content not found' });

      const item = r.rows[0];
      
      // Step 1: If thumbnail_url or preview_url is set, redirect there
      const imageUrl = item.thumbnail_url || item.preview_url;
      if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
        return res.redirect(imageUrl);
      }

      // Step 2: Serve the thumbnail_url file directly from disk (if it exists locally)
      if (imageUrl) {
        const thumbPath = path.join(CONTENT_ROOT, imageUrl);
        const resolvedThumb = path.resolve(thumbPath);
        const resolvedRoot = path.resolve(CONTENT_ROOT);
        if (resolvedThumb.startsWith(resolvedRoot) && fs.existsSync(thumbPath) && fs.statSync(thumbPath).isFile()) {
          const ext = path.extname(imageUrl).toLowerCase();
          const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
          res.setHeader('Content-Type', mimeMap[ext] || 'image/png');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          const stream = fs.createReadStream(thumbPath);
          stream.pipe(res);
          stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
          return;
        }
      }

      // Step 2.5: Fallback — check the metadata bgImage field and serve directly from disk
      const meta = item.metadata || {};
      if (meta.bgImage && typeof meta.bgImage === 'string' && !imageUrl) {
        const bgPath = path.join(CONTENT_ROOT, meta.bgImage);
        const resolvedBg = path.resolve(bgPath);
        const resolvedRoot = path.resolve(CONTENT_ROOT);
        if (resolvedBg.startsWith(resolvedRoot) && fs.existsSync(bgPath) && fs.statSync(bgPath).isFile()) {
          const ext = path.extname(meta.bgImage).toLowerCase();
          const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
          res.setHeader('Content-Type', mimeMap[ext] || 'image/png');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          const stream = fs.createReadStream(bgPath);
          stream.pipe(res);
          stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
          return;
        }
      }

      // Step 3: Fallback — scan the content repo directory recursively for any image files
      const contentDir = path.join(CONTENT_ROOT, assetType + 's', item.slug);
      if (fs.existsSync(contentDir)) {
        const allImages = [];
        const walkImages = (dir) => {
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walkImages(full);
            } else if (entry.isFile() && /\.(png|jpg|jpeg|webp|gif)$/i.test(entry.name)) {
              allImages.push(full);
            }
          }
        };
        walkImages(contentDir);
        if (allImages.length > 0) {
          const chosen = allImages.find(f => /preview|thumb/i.test(path.basename(f))) || allImages[0];
          const ext = path.extname(chosen).toLowerCase();
          const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
          res.setHeader('Content-Type', mimeMap[ext] || 'image/png');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          const stream = fs.createReadStream(chosen);
          stream.pipe(res);
          stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
          return;
        }
      }

      // Step 3: If thumbnail_url is set as a local path, proxy from GitHub
      if (imageUrl) {
        const githubUrl = `https://raw.githubusercontent.com/${GITHUB_CONTENT_REPO}/${GITHUB_CONTENT_BRANCH}/${imageUrl.replace(/^\/+/, '')}`;
        try {
          const https = require('https');
          https.get(githubUrl, { headers: { 'User-Agent': 'Bamboo-Launcher/1.0' } }, (ghRes) => {
            if (ghRes.statusCode === 200) {
              ghRes.pipe(res);
            } else {
              return res.status(404).json({ error: 'Image not found' });
            }
          });
          return;
        } catch {}
      }

      return res.status(404).json({ error: 'No images found for this cosmetic' });
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
        metadata: item => ({ cosmeticType: item.type || 'cape', rarity: item.rarity || 'common', modelUrl: item.model_url || '' }),
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

      // Backend file type validation for cosmetics
      const extErrors = [];
      for (const f of files) {
        if (assetType === 'cosmetic') {
          const ext = (f.fileName || f.filePath || '').split('.').pop()?.toLowerCase() || '';
          const ft = f.fileType || guessFileType(f.filePath || '');
          if (ft === 'model' && ext !== 'json') {
            extErrors.push(`Model file "${f.fileName}" must be .json format`);
          }
          if (ft === 'texture' && ext !== 'png') {
            extErrors.push(`Texture file "${f.fileName}" must be .png format`);
          }
          if (ft === 'icon' && !['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) {
            extErrors.push(`Icon file "${f.fileName}" must be a standard image format`);
          }
        }
      }
      if (extErrors.length > 0) {
        return res.status(400).json({ error: extErrors.join('. ') });
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

      // Also include content_types that have zero entries but are defined
      // so News, Events etc. always appear in the sidebar even when empty
      try {
        const ctResult = await pool.query("SELECT slug, name FROM content_types WHERE is_active = true ORDER BY slug");
        const ctSlugNormalize = { cosmetics: "cosmetic", events: "event", banners: "banner", themes: "theme" };
        for (const ct of ctResult.rows) {
          const typeKey = ctSlugNormalize[ct.slug] || ct.slug;
          if (!types.find(t => t.type === typeKey)) {
            types.push({
              type: typeKey,
              name: ct.name,
              icon: typeIcons[typeKey] || "folder",
              count: 0,
              draftCount: 0,
              publishedCount: 0,
            });
          }
        }
      } catch { /* content_types table might not exist yet */ }

      return res.json({ data: types });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

app.get('/api/content/cosmetics/unlock-types', async (req, res) => {
    try {
      const types = [
        { id: 'playtime_hours',     label: 'Spielzeit (Stunden)',   valueType: 'tree',    unit: 'h',      visualStrategy: 'tree_step',    defaultOp: 'gte', defaultTarget: 5 },
        { id: 'blocks_mined',       label: 'Blöcke abgebaut',       valueType: 'numeric', unit: 'Blöcke', visualStrategy: 'progress_bar', defaultOp: 'gte', defaultTarget: 500 },
        { id: 'mobs_killed',        label: 'Mobs getötet',          valueType: 'numeric', unit: 'Kills',  visualStrategy: 'progress_bar', defaultOp: 'gte', defaultTarget: 100 },
        { id: 'players_killed',     label: 'Spieler getötet',       valueType: 'numeric', unit: 'Kills',  visualStrategy: 'progress_bar', defaultOp: 'gte', defaultTarget: 10 },
        { id: 'distance_traveled',  label: 'Zurückgelegte Distanz', valueType: 'numeric', unit: 'Blöcke', visualStrategy: 'progress_bar', defaultOp: 'gte', defaultTarget: 50000 },
        { id: 'login_days',         label: 'Login-Tage',            valueType: 'numeric', unit: 'Tage',   visualStrategy: 'progress_bar', defaultOp: 'gte', defaultTarget: 7 },
        { id: 'achievement_id',     label: 'Achievement',           valueType: 'string',  visualStrategy: 'checkpoint',   defaultOp: 'eq',  defaultTarget: 'explorer' },
        { id: 'event_id',           label: 'Event',                 valueType: 'string',  visualStrategy: 'checkpoint',   defaultOp: 'eq',  defaultTarget: 'event-2026' },
        { id: 'rank_id',            label: 'Rang',                  valueType: 'string',  visualStrategy: 'checkpoint',   defaultOp: 'eq',  defaultTarget: 'Builder' },
        { id: 'server_id',          label: 'Server-Verbindung',     valueType: 'string',  visualStrategy: 'checkpoint',   defaultOp: 'eq',  defaultTarget: 'bamboo-main' },
        { id: 'invite_code',        label: 'Invite-Code',           valueType: 'string',  visualStrategy: 'checkpoint',   defaultOp: 'eq',  defaultTarget: '' },
      ];
      return res.json({ success: true, data: types });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================================
  // === GET /api/content/cosmetics/trees ================================
  // Returns unlock trees (Minecraft-style milestones). Default + custom.
  // ====================================================================
  app.get('/api/content/cosmetics/trees', async (req, res) => {
    try {
      const playtimeTree = {
        treeId: 'playtime_hours',
        root: {
          id: 'pt_0h', label: '0 Stunden', thresholdValue: 0, unlocksCosmeticIds: [],
          children: [
            { id: 'pt_5h', label: '5 Stunden', thresholdValue: 5, unlocksCosmeticIds: [], children: [
              { id: 'pt_10h', label: '10 Stunden', thresholdValue: 10, unlocksCosmeticIds: [], children: [
                { id: 'pt_25h', label: '25 Stunden', thresholdValue: 25, unlocksCosmeticIds: [], children: [
                  { id: 'pt_50h', label: '50 Stunden', thresholdValue: 50, unlocksCosmeticIds: [], children: [
                    { id: 'pt_100h', label: '100 Stunden', thresholdValue: 100, unlocksCosmeticIds: [], children: [
                      { id: 'pt_250h', label: '250 Stunden', thresholdValue: 250, unlocksCosmeticIds: [], children: [
                        { id: 'pt_500h', label: '500 Stunden', thresholdValue: 500, unlocksCosmeticIds: [], children: [
                          { id: 'pt_1000h', label: '1000 Stunden', thresholdValue: 1000, unlocksCosmeticIds: [] }
                        ]}
                      ]}
                    ]}
                  ]}
                ]}
              ]}
            ]}
          ]
        }
      };
      const customTrees = [];
      try {
        if (pool && dbState.connected) {
          const r = await pool.query("SELECT metadata FROM assets WHERE asset_type = 'unlock_tree' AND status = 'published'");
          for (const row of r.rows) {
            const md = row.metadata || {};
            if (md.tree) customTrees.push(md.tree);
          }
        }
      } catch { /* table may not exist yet */ }
      return res.json({ success: true, data: [playtimeTree, ...customTrees] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
};
