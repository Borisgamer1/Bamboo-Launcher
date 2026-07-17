-- ============================================================
-- Phase 11: Profile Import/Export & Bamboo Share - Database Migration
-- ============================================================
-- Ausführung: psql -U postgres -d bamboo_launcher -f server/migrations/011-profile-share.sql
-- ============================================================

-- === Bamboo Shares (generierte Share-Codes) ===
CREATE TABLE IF NOT EXISTS bamboo_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    share_code VARCHAR(16) UNIQUE NOT NULL,
    author_id UUID REFERENCES friend_users(id) ON DELETE SET NULL,
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
);

CREATE INDEX IF NOT EXISTS idx_bamboo_shares_code ON bamboo_shares(share_code);
CREATE INDEX IF NOT EXISTS idx_bamboo_shares_author ON bamboo_shares(author_id);
CREATE INDEX IF NOT EXISTS idx_bamboo_shares_active ON bamboo_shares(is_active);
CREATE INDEX IF NOT EXISTS idx_bamboo_shares_created ON bamboo_shares(created_at DESC);

-- === Share Downloads (tracking) ===
CREATE TABLE IF NOT EXISTS share_downloads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    share_id UUID NOT NULL REFERENCES bamboo_shares(id) ON DELETE CASCADE,
    downloader_ip VARCHAR(45) DEFAULT '',
    downloader_username VARCHAR(128) DEFAULT '',
    user_agent TEXT DEFAULT '',
    downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_downloads_share ON share_downloads(share_id);
CREATE INDEX IF NOT EXISTS idx_share_downloads_date ON share_downloads(downloaded_at DESC);

-- === Profile Exports (local tracking) ===
CREATE TABLE IF NOT EXISTS profile_exports (
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
);

CREATE INDEX IF NOT EXISTS idx_profile_exports_instance ON profile_exports(instance_id);
CREATE INDEX IF NOT EXISTS idx_profile_exports_format ON profile_exports(export_format);

-- === Profile Imports (local tracking) ===
CREATE TABLE IF NOT EXISTS profile_imports (
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
);

CREATE INDEX IF NOT EXISTS idx_profile_imports_format ON profile_imports(import_format);
CREATE INDEX IF NOT EXISTS idx_profile_imports_date ON profile_imports(imported_at DESC);

-- === Verify Tables ===
SELECT 'bamboo_shares' as table_name, COUNT(*) as row_count FROM bamboo_shares
UNION ALL SELECT 'share_downloads', COUNT(*) FROM share_downloads
UNION ALL SELECT 'profile_exports', COUNT(*) FROM profile_exports
UNION ALL SELECT 'profile_imports', COUNT(*) FROM profile_imports
ORDER BY table_name;

-- ============================================================
-- Migration abgeschlossen
-- ============================================================
