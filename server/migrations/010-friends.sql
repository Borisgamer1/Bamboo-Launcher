-- ============================================================
-- Phase 10: Friends, Profiles & P2P - Database Migration
-- ============================================================
-- Führt alle benötigten Tabellen für das Freundesystem ein.
-- Ausführung: psql -U postgres -d bamboo_launcher -f server/migrations/010-friends.sql
-- ============================================================

-- === Users (erweitert für Friends-System) ===
CREATE TABLE IF NOT EXISTS friend_users (
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
);

CREATE INDEX IF NOT EXISTS idx_friend_users_username ON friend_users(username);
CREATE INDEX IF NOT EXISTS idx_friend_users_status ON friend_users(status);
CREATE INDEX IF NOT EXISTS idx_friend_users_display_name ON friend_users(display_name);

-- === Friendships (akzeptierte Freundschaften) ===
CREATE TABLE IF NOT EXISTS friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    friend_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, friend_id),
    CHECK(user_id <> friend_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);

-- === Friend Requests (ausstehende Anfragen) ===
CREATE TABLE IF NOT EXISTS friend_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    to_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    message VARCHAR(256) DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(from_user, to_user)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user);
CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user);

-- === Blocked Users ===
CREATE TABLE IF NOT EXISTS blocked_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocked_users_user ON blocked_users(user_id);

-- === Invitations (Einladungen zu Instanzen/Servern) ===
CREATE TABLE IF NOT EXISTS invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    to_user UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    type VARCHAR(32) NOT NULL DEFAULT 'instance' CHECK(type IN ('instance','server','realm','modpack','profile_share')),
    detail VARCHAR(256) DEFAULT '',
    payload JSONB DEFAULT '{}'::jsonb,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_invitations_from ON invitations(from_user);
CREATE INDEX IF NOT EXISTS idx_invitations_to ON invitations(to_user);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);

-- === Presence History (für Rich Presence und Aktivitätsverlauf) ===
CREATE TABLE IF NOT EXISTS presence_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL,
    activity JSONB DEFAULT '{}'::jsonb,
    session_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_presence_history_user ON presence_history(user_id);
CREATE INDEX IF NOT EXISTS idx_presence_history_session ON presence_history(user_id, session_start DESC);

-- === Notifications (für späteres Benachrichtigungssystem) ===
CREATE TABLE IF NOT EXISTS friend_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES friend_users(id) ON DELETE CASCADE,
    from_user UUID REFERENCES friend_users(id) ON DELETE CASCADE,
    type VARCHAR(32) NOT NULL DEFAULT 'friend_request' CHECK(type IN ('friend_online','friend_started_game','friend_request','request_accepted','profile_updated','invitation')),
    message TEXT DEFAULT '',
    payload JSONB DEFAULT '{}'::jsonb,
    read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_friend_notifications_user ON friend_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_friend_notifications_unread ON friend_notifications(user_id, read);

-- === Verify Tables ===
SELECT 'friend_users' as table_name, COUNT(*) as row_count FROM friend_users
UNION ALL SELECT 'friendships', COUNT(*) FROM friendships
UNION ALL SELECT 'friend_requests', COUNT(*) FROM friend_requests
UNION ALL SELECT 'blocked_users', COUNT(*) FROM blocked_users
UNION ALL SELECT 'invitations', COUNT(*) FROM invitations
UNION ALL SELECT 'presence_history', COUNT(*) FROM presence_history
UNION ALL SELECT 'friend_notifications', COUNT(*) FROM friend_notifications
ORDER BY table_name;

-- ============================================================
-- Migration abgeschlossen
-- ============================================================
