const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

require('dotenv').config();

const PORT = process.env.PORT || 3400;
const WS_PORT = process.env.WS_PORT || 3401;
const JWT_SECRET = process.env.JWT_SECRET || 'bamboo-friends-secret-2026';

// ===== PostgreSQL Connection =====
let pool = null;
let dbConnected = false;

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
  console.error('[friends] PostgreSQL not available:', err.message);
  process.exit(1);
}

async function initDatabase() {
  if (!pool) return;
  try {
    // === friend_users ===
    await pool.query(`CREATE TABLE IF NOT EXISTS friend_users (
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
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fu_username ON friend_users(username)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fu_status ON friend_users(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fu_display_name ON friend_users(display_name)`);

    // === friendships ===
    await pool.query(`CREATE TABLE IF NOT EXISTS friendships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
      friend_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
      since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, friend_id),
      CHECK(user_id <> friend_id)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fs_user ON friendships(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fs_friend ON friendships(friend_id)`);

    // === friend_requests ===
    await pool.query(`CREATE TABLE IF NOT EXISTS friend_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
      to_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
      message VARCHAR(256) DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(from_user, to_user)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fr_from ON friend_requests(from_user)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fr_to ON friend_requests(to_user)`);

    // === blocked_users ===
    await pool.query(`CREATE TABLE IF NOT EXISTS blocked_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
      blocked_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, blocked_id)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bu_user ON blocked_users(user_id)`);

    // === invitations ===
    await pool.query(`CREATE TABLE IF NOT EXISTS invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
      to_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
      type VARCHAR(32) NOT NULL DEFAULT 'instance' CHECK(type IN ('instance','server','realm','modpack','profile_share')),
      detail VARCHAR(256) DEFAULT '',
      payload JSONB DEFAULT '{}'::jsonb,
      status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      responded_at TIMESTAMPTZ
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_inv_from ON invitations(from_user)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_inv_to ON invitations(to_user)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_inv_status ON invitations(status)`);

    // === presence_history ===
    await pool.query(`CREATE TABLE IF NOT EXISTS presence_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
      status VARCHAR(16) NOT NULL,
      activity JSONB DEFAULT '{}'::jsonb,
      session_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      session_end TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ph_user ON presence_history(user_id)`);

    // === friend_notifications ===
    await pool.query(`CREATE TABLE IF NOT EXISTS friend_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
      from_user UUID REFERENCES friend_users(id) ON DELETE CASCADE,
      type VARCHAR(32) NOT NULL DEFAULT 'friend_request' CHECK(type IN ('friend_online','friend_started_game','friend_request','request_accepted','profile_updated','invitation')),
      message TEXT DEFAULT '',
      payload JSONB DEFAULT '{}'::jsonb,
      read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fn_user ON friend_notifications(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fn_unread ON friend_notifications(user_id, read)`);

    dbConnected = true;
    console.log('[friends] PostgreSQL connected, all tables initialized');
  } catch (err) {
    console.error('[friends] Database init failed:', err.message);
    process.exit(1);
  }
}

// ===== Express App =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ===== Auth Middleware =====
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ===== Sanitize Helper =====
function sanitizeUser(u) {
  if (!u) return null;
  const { password_hash, ...safe } = u;
  return {
    id: safe.id,
    username: safe.username,
    displayName: safe.display_name || safe.username,
    avatar: safe.avatar || '🎋',
    banner: safe.banner || '',
    bio: safe.bio || '',
    accentColor: safe.accent_color || '#4CAF50',
    customStatus: safe.custom_status || '',
    launcherVersion: safe.launcher_version || '0.1.0',
    favoriteGame: safe.favorite_game || '',
    favoriteInstance: safe.favorite_instance || '',
    launcherLevel: safe.launcher_level || 1,
    badges: safe.badges || [],
    createdAt: safe.created_at ? new Date(safe.created_at).toISOString() : null,
    lastOnline: safe.last_online ? new Date(safe.last_online).toISOString() : null,
    status: safe.status || 'offline',
    activity: safe.activity || { type: 'offline' },
    friendCount: safe.friend_count || 0,
  };
}

// ===== Health =====
app.get('/health', (req, res) => {
  if (!dbConnected) return res.status(503).json({ status: 'error', database: 'disconnected' });
  res.json({ status: 'ok', database: 'connected', version: '0.1.0' });
});

// ======================================================================
// AUTH
// ======================================================================
app.post('/auth/register', async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const { username, displayName, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (username.length > 32) return res.status(400).json({ error: 'Username too long (max 32)' });

    const existing = await pool.query('SELECT id FROM friend_users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const r = await pool.query(
      `INSERT INTO friend_users (id, username, display_name, password_hash, created_at, last_online, status)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), 'online') RETURNING *`,
      [id, username, displayName || username, hash]
    );

    const token = jwt.sign({ id: r.rows[0].id, username: r.rows[0].username }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: sanitizeUser(r.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const r = await pool.query('SELECT * FROM friend_users WHERE username = $1', [username]);
    if (r.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = r.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// USER SEARCH & PROFILES
// ======================================================================
app.get('/users/search', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const q = (req.query.q || '').toLowerCase();
    if (!q || q.length < 1) return res.json([]);

    const r = await pool.query(
      `SELECT * FROM friend_users WHERE id != $1 AND (LOWER(username) LIKE $2 OR LOWER(display_name) LIKE $2) LIMIT 20`,
      [req.user.id, `%${q}%`]
    );
    res.json(r.rows.map(sanitizeUser));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/users/:id', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query('SELECT * FROM friend_users WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = r.rows[0];
    // Check privacy
    const privacy = user.privacy_settings || {};
    if (privacy.profileVisible === 'nobody' && user.id !== req.user.id) {
      return res.status(403).json({ error: 'Profile not visible' });
    }
    if (privacy.profileVisible === 'friends' && user.id !== req.user.id) {
      const isFriend = await pool.query(
        `SELECT id FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
        [req.user.id, user.id]
      );
      if (isFriend.rows.length === 0) {
        return res.status(403).json({ error: 'Profile only visible to friends' });
      }
    }

    res.json(sanitizeUser(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Own profile
app.get('/profile/me', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query('SELECT * FROM friend_users WHERE id = $1', [req.user.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(sanitizeUser(r.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update profile
app.put('/profile/me', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const allowed = ['display_name', 'avatar', 'banner', 'bio', 'accent_color', 'custom_status',
      'launcher_version', 'favorite_game', 'favorite_instance'];
    const updates = [];
    const values = [];
    let i = 1;

    for (const key of allowed) {
      const bodyKey = key === 'display_name' ? 'displayName' :
        key === 'accent_color' ? 'accentColor' :
        key === 'custom_status' ? 'customStatus' :
        key === 'launcher_version' ? 'launcherVersion' :
        key === 'favorite_game' ? 'favoriteGame' :
        key === 'favorite_instance' ? 'favoriteInstance' : key;
      if (req.body[bodyKey] !== undefined) {
        updates.push(`${key}=$${i++}`);
        values.push(req.body[bodyKey]);
      }
    }

    if (req.body.privacySettings) {
      updates.push(`privacy_settings=$${i++}`);
      values.push(JSON.stringify(req.body.privacySettings));
    }

    if (updates.length > 0) {
      values.push(req.user.id);
      await pool.query(
        `UPDATE friend_users SET ${updates.join(', ')} WHERE id=$${i}`,
        values
      );
    }

    const r = await pool.query('SELECT * FROM friend_users WHERE id = $1', [req.user.id]);
    // Broadcast profile update to friends
    broadcastToFriends(req.user.id, {
      type: 'friend_profile_updated',
      userId: req.user.id,
      profile: sanitizeUser(r.rows[0]),
    });

    res.json(sanitizeUser(r.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Privacy settings
app.get('/profile/privacy', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query('SELECT privacy_settings FROM friend_users WHERE id = $1', [req.user.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0].privacy_settings || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// FRIENDS
// ======================================================================

// Send friend request
app.post('/friends/request', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const { userId, message } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (userId === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });

    const target = await pool.query('SELECT * FROM friend_users WHERE id = $1', [userId]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    // Check existing friendship
    const existing = await pool.query(
      `SELECT id FROM friendships WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)`,
      [req.user.id, userId]
    );
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Already friends' });

    // Check existing request
    const existingReq = await pool.query(
      `SELECT id FROM friend_requests WHERE (from_user=$1 AND to_user=$2) OR (from_user=$2 AND to_user=$1)`,
      [req.user.id, userId]
    );
    if (existingReq.rows.length > 0) return res.status(409).json({ error: 'Request already exists' });

    // Check if blocked
    const blocked = await pool.query(
      `SELECT id FROM blocked_users WHERE (user_id=$1 AND blocked_id=$2) OR (user_id=$2 AND blocked_id=$1)`,
      [req.user.id, userId]
    );
    if (blocked.rows.length > 0) return res.status(403).json({ error: 'Cannot send request' });

    // Check privacy
    const privacy = target.rows[0].privacy_settings || {};
    if (privacy.whoCanAdd === 'nobody') {
      return res.status(403).json({ error: 'This user does not accept friend requests' });
    }

    await pool.query(
      'INSERT INTO friend_requests (from_user, to_user, message) VALUES ($1, $2, $3)',
      [req.user.id, userId, message || '']
    );

    // Get sender info for notification
    const sender = await pool.query('SELECT username, display_name, avatar FROM friend_users WHERE id = $1', [req.user.id]);

    // Create notification for recipient
    await pool.query(
      `INSERT INTO friend_notifications (user_id, from_user, type, message, payload)
       VALUES ($1, $2, 'friend_request', $3, $4)`,
      [userId, req.user.id,
       `${sender.rows[0].display_name || sender.rows[0].username} möchte dich als Freund hinzufügen.`,
       JSON.stringify({ message: message || '' })]
    );

    // Real-time notification via WebSocket
    notifyUser(userId, {
      type: 'friend_request',
      fromUserId: req.user.id,
      fromUserName: sender.rows[0].display_name || sender.rows[0].username,
      fromUserAvatar: sender.rows[0].avatar || '🎋',
      message: message ? `${sender.rows[0].username}: "${message}"` : `${sender.rows[0].username} möchte dich als Freund hinzufügen.`,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept friend request
app.post('/friends/accept', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const { userId } = req.body;

    const request = await pool.query(
      'SELECT * FROM friend_requests WHERE from_user=$1 AND to_user=$2',
      [userId, req.user.id]
    );
    if (request.rows.length === 0) return res.status(404).json({ error: 'No pending request' });

    // Delete request and create bidirectional friendship
    await pool.query('DELETE FROM friend_requests WHERE from_user=$1 AND to_user=$2', [userId, req.user.id]);
    await pool.query('INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING',
      [req.user.id, userId]);

    // Update friend counts
    await pool.query('UPDATE friend_users SET friend_count=(SELECT COUNT(*) FROM friendships WHERE user_id=$1) WHERE id=$1',
      [req.user.id]);
    await pool.query('UPDATE friend_users SET friend_count=(SELECT COUNT(*) FROM friendships WHERE user_id=$1) WHERE id=$1',
      [userId]);

    const me = await pool.query('SELECT * FROM friend_users WHERE id=$1', [req.user.id]);
    const them = await pool.query('SELECT * FROM friend_users WHERE id=$1', [userId]);

    // Notification for the requester
    await pool.query(
      `INSERT INTO friend_notifications (user_id, from_user, type, message)
       VALUES ($1, $2, 'request_accepted', $3)`,
      [userId, req.user.id, `${me.rows[0].display_name || me.rows[0].username} hat deine Freundschaftsanfrage angenommen.`]
    );

    // Real-time notification
    notifyUser(userId, {
      type: 'friend_request_accepted',
      fromUserId: req.user.id,
      fromUserName: me.rows[0].display_name || me.rows[0].username,
      fromUserAvatar: me.rows[0].avatar || '🎋',
      message: `${me.rows[0].username} hat deine Freundschaftsanfrage angenommen.`,
      profile: sanitizeUser(me.rows[0]),
    });

    // Tell the accepter about the new friend
    notifyUser(req.user.id, {
      type: 'friend_added',
      userId,
      profile: sanitizeUser(them.rows[0]),
    });

    // Broadcast online status to new friends
    if (me.rows[0].status === 'online') {
      notifyUser(userId, {
        type: 'friend_online',
        userId: req.user.id,
        profile: sanitizeUser(me.rows[0]),
      });
    }
    if (them.rows[0].status === 'online') {
      notifyUser(req.user.id, {
        type: 'friend_online',
        userId,
        profile: sanitizeUser(them.rows[0]),
      });
    }

    res.json({ success: true, friend: sanitizeUser(them.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Decline friend request
app.post('/friends/decline', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const { userId } = req.body;
    await pool.query('DELETE FROM friend_requests WHERE from_user=$1 AND to_user=$2', [userId, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove friend
app.post('/friends/remove', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const { userId } = req.body;
    await pool.query(
      'DELETE FROM friendships WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)',
      [req.user.id, userId]
    );
    await pool.query('UPDATE friend_users SET friend_count=(SELECT COUNT(*) FROM friendships WHERE user_id=$1) WHERE id=$1',
      [req.user.id]);
    await pool.query('UPDATE friend_users SET friend_count=(SELECT COUNT(*) FROM friendships WHERE user_id=$1) WHERE id=$1',
      [userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Block user
app.post('/friends/block', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const { userId } = req.body;
    // Remove any friendships
    await pool.query(
      'DELETE FROM friendships WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)',
      [req.user.id, userId]
    );
    // Remove any requests
    await pool.query(
      'DELETE FROM friend_requests WHERE (from_user=$1 AND to_user=$2) OR (from_user=$2 AND to_user=$1)',
      [req.user.id, userId]
    );
    // Add block
    await pool.query(
      'INSERT INTO blocked_users (user_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unblock user
app.post('/friends/unblock', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const { userId } = req.body;
    await pool.query('DELETE FROM blocked_users WHERE user_id=$1 AND blocked_id=$2', [req.user.id, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get friends list
app.get('/friends', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query(
      `SELECT fu.* FROM friend_users fu
       INNER JOIN friendships f ON (f.friend_id = fu.id)
       WHERE f.user_id = $1
       ORDER BY fu.status = 'online' DESC, fu.status = 'busy' DESC, fu.display_name ASC`,
      [req.user.id]
    );
    res.json(r.rows.map(sanitizeUser));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get pending friend requests (incoming)
app.get('/friends/requests', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query(
      `SELECT fr.*, fu.username, fu.display_name, fu.avatar
       FROM friend_requests fr
       INNER JOIN friend_users fu ON fu.id = fr.from_user
       WHERE fr.to_user = $1
       ORDER BY fr.created_at DESC`,
      [req.user.id]
    );
    res.json(r.rows.map(row => ({
      id: row.id,
      from: row.from_user,
      to: row.to_user,
      message: row.message || '',
      timestamp: row.created_at ? new Date(row.created_at).toISOString() : null,
      fromUser: {
        id: row.from_user,
        username: row.username,
        displayName: row.display_name,
        avatar: row.avatar,
      },
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get sent requests
app.get('/friends/requests/sent', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query(
      `SELECT fr.*, fu.username, fu.display_name, fu.avatar
       FROM friend_requests fr
       INNER JOIN friend_users fu ON fu.id = fr.to_user
       WHERE fr.from_user = $1
       ORDER BY fr.created_at DESC`,
      [req.user.id]
    );
    res.json(r.rows.map(row => ({
      id: row.id,
      from: row.from_user,
      to: row.to_user,
      message: row.message || '',
      timestamp: row.created_at ? new Date(row.created_at).toISOString() : null,
      toUser: sanitizeUser({
        id: row.to_user,
        username: row.username,
        display_name: row.display_name,
        avatar: row.avatar,
      }),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get blocked users
app.get('/friends/blocked', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query(
      `SELECT fu.* FROM friend_users fu
       INNER JOIN blocked_users b ON b.blocked_id = fu.id
       WHERE b.user_id = $1`,
      [req.user.id]
    );
    res.json(r.rows.map(sanitizeUser));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get friend suggestions
app.get('/friends/suggestions', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const friendIds = await pool.query(
      `SELECT friend_id FROM friendships WHERE user_id=$1
       UNION SELECT user_id FROM friendships WHERE friend_id=$1`,
      [req.user.id]
    );
    const excludeIds = [req.user.id, ...friendIds.rows.map(r => r.friend_id)];
    const r = await pool.query(
      `SELECT * FROM friend_users WHERE id != ALL($1) ORDER BY random() LIMIT 10`,
      [excludeIds]
    );
    res.json(r.rows.map(sanitizeUser));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// PRESENCE
// ======================================================================
app.put('/presence/status', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const { status } = req.body;
    if (!status || !['online', 'busy', 'away', 'dnd', 'invisible', 'offline'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await pool.query('UPDATE friend_users SET status=$1, last_online=NOW() WHERE id=$2', [status, req.user.id]);

    // Record presence history
    await pool.query(
      'INSERT INTO presence_history (user_id, status, activity, session_start) VALUES ($1, $2, $3, NOW())',
      [req.user.id, status, JSON.stringify({ type: 'in_launcher' })]
    );

    // Broadcast to friends
    broadcastToFriends(req.user.id, {
      type: 'friend_status',
      userId: req.user.id,
      status,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/presence/activity', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const activity = req.body;
    if (!activity || !activity.type) return res.status(400).json({ error: 'Activity type required' });

    const activityJson = JSON.stringify(activity);
    await pool.query('UPDATE friend_users SET activity=$1::jsonb WHERE id=$2', [activityJson, req.user.id]);

    // Broadcast to friends
    broadcastToFriends(req.user.id, {
      type: 'friend_activity',
      userId: req.user.id,
      activity,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get online friends
app.get('/presence/online', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query(
      `SELECT fu.* FROM friend_users fu
       INNER JOIN friendships f ON (f.friend_id = fu.id)
       WHERE f.user_id = $1 AND fu.status IN ('online', 'busy', 'away', 'dnd')
       ORDER BY fu.status = 'online' DESC, fu.display_name ASC`,
      [req.user.id]
    );
    res.json(r.rows.map(sanitizeUser));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// INVITATIONS
// ======================================================================
app.post('/invitations/send', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const { toUserId, type, detail, payload } = req.body;
    if (!toUserId || !type) return res.status(400).json({ error: 'toUserId and type required' });

    // Verify friendship
    const isFriend = await pool.query(
      'SELECT id FROM friendships WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)',
      [req.user.id, toUserId]
    );
    if (isFriend.rows.length === 0) return res.status(403).json({ error: 'Not friends' });

    const id = uuidv4();
    await pool.query(
      `INSERT INTO invitations (id, from_user, to_user, type, detail, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, req.user.id, toUserId, type, detail || '', JSON.stringify(payload || {})]
    );

    // Get sender info
    const sender = await pool.query('SELECT username, display_name, avatar FROM friend_users WHERE id = $1', [req.user.id]);

    // Notification
    await pool.query(
      `INSERT INTO friend_notifications (user_id, from_user, type, message, payload)
       VALUES ($1, $2, 'invitation', $3, $4)`,
      [toUserId, req.user.id,
       `${sender.rows[0].display_name || sender.rows[0].username} hat dir eine Einladung gesendet.`,
       JSON.stringify({ invitationId: id, type, detail, payload })]
    );

    notifyUser(toUserId, {
      type: 'invitation',
      fromUserId: req.user.id,
      fromUserName: sender.rows[0].display_name || sender.rows[0].username,
      fromUserAvatar: sender.rows[0].avatar || '🎋',
      invitationId: id,
      invitationType: type,
      invitationDetail: detail,
      payload,
    });

    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/invitations/respond', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const { invitationId, accept } = req.body;

    const inv = await pool.query(
      'SELECT * FROM invitations WHERE id=$1 AND to_user=$2 AND status=$3',
      [invitationId, req.user.id, 'pending']
    );
    if (inv.rows.length === 0) return res.status(404).json({ error: 'Invitation not found' });

    const newStatus = accept ? 'accepted' : 'declined';
    await pool.query(
      'UPDATE invitations SET status=$1, responded_at=NOW() WHERE id=$2',
      [newStatus, invitationId]
    );

    // Notify sender
    const responder = await pool.query('SELECT username, display_name FROM friend_users WHERE id=$1', [req.user.id]);
    notifyUser(inv.rows[0].from_user, {
      type: 'invitation_response',
      fromUserId: req.user.id,
      fromUserName: responder.rows[0].display_name || responder.rows[0].username,
      accepted: accept,
      invitationId,
    });

    res.json({ success: true, status: newStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/invitations', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query(
      `SELECT i.*, fu.username, fu.display_name, fu.avatar
       FROM invitations i
       INNER JOIN friend_users fu ON fu.id = i.from_user
       WHERE i.to_user = $1 AND i.status = 'pending'
       ORDER BY i.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(r.rows.map(row => ({
      id: row.id,
      fromUser: sanitizeUser(row),
      type: row.type,
      detail: row.detail || '',
      payload: row.payload || {},
      status: row.status,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// NOTIFICATIONS
// ======================================================================
app.get('/notifications', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    const r = await pool.query(
      `SELECT fn.*, fu.username, fu.display_name, fu.avatar
       FROM friend_notifications fn
       LEFT JOIN friend_users fu ON fu.id = fn.from_user
       WHERE fn.user_id = $1
       ORDER BY fn.created_at DESC
       LIMIT 100`,
      [req.user.id]
    );
    res.json(r.rows.map(row => ({
      id: row.id,
      type: row.type,
      fromUserId: row.from_user,
      fromUserName: row.display_name || row.username || '',
      fromUserAvatar: row.avatar || '🎋',
      message: row.message || '',
      payload: row.payload || {},
      read: row.read,
      timestamp: row.created_at ? new Date(row.created_at).toISOString() : null,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/notifications/read/:id', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    await pool.query(
      'UPDATE friend_notifications SET read=true WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/notifications/read-all', authenticate, async (req, res) => {
  try {
    if (!dbConnected) return res.status(503).json({ error: 'Database not available' });
    await pool.query(
      'UPDATE friend_notifications SET read=true WHERE user_id=$1',
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// P2P PREPARATION
// ======================================================================
app.get('/p2p/status', authenticate, async (req, res) => {
  // P2P architecture prepared - returns available peers
  res.json({
    supported: true,
    protocols: ['direct', 'relay'],
    features: ['file_transfer', 'voice_chat_planned'],
    status: 'prepared',
  });
});

app.post('/p2p/signal', authenticate, async (req, res) => {
  // WebRTC signaling endpoint (prepared for future use)
  const { targetUserId, signal } = req.body;
  if (!targetUserId || !signal) return res.status(400).json({ error: 'targetUserId and signal required' });

  // Forward signal to target user if online
  const isFriend = await pool.query(
    'SELECT id FROM friendships WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)',
    [req.user.id, targetUserId]
  );
  if (isFriend.rows.length === 0) return res.status(403).json({ error: 'Not friends' });

  notifyUser(targetUserId, {
    type: 'p2p_signal',
    fromUserId: req.user.id,
    signal,
  });

  res.json({ success: true, forwarded: true });
});

// ======================================================================
// WebSocket Server
// ======================================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Map(); // userId -> WebSocket[]

function handleWsConnection(ws) {
  let userId = null;

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'auth': {
          try {
            const decoded = jwt.verify(msg.token, JWT_SECRET);
            userId = decoded.id;

            if (!clients.has(userId)) clients.set(userId, []);
            clients.get(userId).push(ws);

            // Update status
            await pool.query(
              'UPDATE friend_users SET status=$1, last_online=NOW() WHERE id=$2',
              [msg.status || 'online', userId]
            );

            // Record presence
            await pool.query(
              'INSERT INTO presence_history (user_id, status, activity, session_start) VALUES ($1, $2, $3, NOW())',
              [userId, msg.status || 'online', JSON.stringify({ type: 'in_launcher' })]
            );

            // Get user profile
            const user = await pool.query('SELECT * FROM friend_users WHERE id=$1', [userId]);

            // Broadcast to friends
            broadcastToFriends(userId, {
              type: 'friend_online',
              userId,
              profile: sanitizeUser(user.rows[0]),
            });

            // Send current online friends to the newly connected user
            const onlineFriends = await pool.query(
              `SELECT fu.* FROM friend_users fu
               INNER JOIN friendships f ON (f.friend_id = fu.id)
               WHERE f.user_id = $1 AND fu.status IN ('online', 'busy', 'away', 'dnd')
               AND fu.id != $1`,
              [userId]
            );
            if (onlineFriends.rows.length > 0) {
              ws.send(JSON.stringify({
                type: 'friends_online',
                friends: onlineFriends.rows.map(sanitizeUser),
              }));
            }

            ws.send(JSON.stringify({ type: 'auth_ok', userId }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
          }
          break;
        }
        case 'status': {
          if (!userId) break;
          if (!['online', 'busy', 'away', 'dnd', 'invisible', 'offline'].includes(msg.status)) break;
          await pool.query('UPDATE friend_users SET status=$1 WHERE id=$2', [msg.status, userId]);
          broadcastToFriends(userId, { type: 'friend_status', userId, status: msg.status });
          break;
        }
        case 'activity': {
          if (!userId || !msg.activity) break;
          const activityJson = JSON.stringify(msg.activity);
          await pool.query('UPDATE friend_users SET activity=$1::jsonb WHERE id=$2', [activityJson, userId]);
          broadcastToFriends(userId, { type: 'friend_activity', userId, activity: msg.activity });
          break;
        }
        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }
      }
    } catch (e) {
      console.warn('[WS] Message error:', e.message);
    }
  });

  ws.on('close', async () => {
    if (userId && clients.has(userId)) {
      const list = clients.get(userId).filter(c => c !== ws);
      if (list.length === 0) {
        clients.delete(userId);
        // Set offline after a short delay (in case of reconnection)
        setTimeout(async () => {
          if (!clients.has(userId)) {
            await pool.query(
              'UPDATE friend_users SET status=$1, last_online=NOW() WHERE id=$2',
              ['offline', userId]
            );
            broadcastToFriends(userId, { type: 'friend_offline', userId });
          }
        }, 3000);
      } else {
        clients.set(userId, list);
      }
    }
  });
}

wss.on('connection', handleWsConnection);

// Also expose WebSocket on WS_PORT (fallback für lokale Entwicklung)
let wsServer2 = null;
try {
  wsServer2 = new WebSocketServer({ port: WS_PORT });
  wsServer2.on('connection', handleWsConnection);
  console.log(`[friends] Fallback WebSocket ready on port ${WS_PORT}`);
} catch (e) {
  console.warn(`[friends] Fallback WebSocket port ${WS_PORT} nicht verfügbar: ${e.message}`);
}

// ===== Helpers =====
function notifyUser(targetUserId, message) {
  if (clients.has(targetUserId)) {
    const msg = JSON.stringify(message);
    clients.get(targetUserId).forEach(ws => {
      try { ws.send(msg); } catch (e) {
        if (e.message !== 'WebSocket is not open') {
          console.warn('[notify] send error:', e.message);
        }
      }
    });
  }
}

async function broadcastToFriends(userId, message) {
  const msg = JSON.stringify(message);
  try {
    const friendIds = await pool.query(
      `SELECT friend_id FROM friendships WHERE user_id=$1
       UNION SELECT user_id FROM friendships WHERE friend_id=$1`,
      [userId]
    );
    for (const row of friendIds.rows) {
      const fid = row.friend_id;
      if (clients.has(fid)) {
        clients.get(fid).forEach(ws => {
          try { ws.send(msg); } catch (e) {
            if (e.message !== 'WebSocket is not open') {
              console.warn('[broadcast] send error:', e.message);
            }
          }
        });
      }
    }
  } catch (e) {
    console.warn('[broadcast] query error:', e.message);
  }
}

// ===== Start =====
async function start() {
  await initDatabase();
  server.listen(PORT, () => {
    console.log(`🌐 Bamboo Friends API running on port ${PORT}`);
    console.log(`🔌 WebSocket ready on port ${PORT} and port ${WS_PORT}`);
  });
}

// Nur automatisch starten wenn direkt ausgeführt (nicht per require geladen)
if (require.main === module) {
  start();
}

module.exports = { app, server, start, pool, initDatabase, WS_PORT, wss, handleWsConnection, notifyUser, broadcastToFriends, clients };
