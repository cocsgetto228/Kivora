-- Kivora schema. Written in the intersection of SQLite and PostgreSQL syntax so
-- one file serves both drivers. Types are deliberately generic (TEXT/BLOB/INTEGER
-- are accepted by SQLite; the postgres driver rewrites BLOB->BYTEA at load time).

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_hue    INTEGER NOT NULL DEFAULT 0,
    avatar        TEXT NOT NULL DEFAULT '',   -- uploads.id, or '' for the generated initial
    bio           TEXT NOT NULL DEFAULT '',
    is_admin      INTEGER NOT NULL DEFAULT 0,
    suspended     INTEGER NOT NULL DEFAULT 0, -- set by an admin; also drops sessions
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL DEFAULT 0
);

-- Every login on a new machine is a device with its own long-term identity key.
-- The server stores only public material; private keys never leave the client.
CREATE TABLE IF NOT EXISTS devices (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    platform          TEXT NOT NULL DEFAULT '',
    suite             TEXT NOT NULL,
    identity_pub      BLOB NOT NULL,
    signed_prekey_pub BLOB NOT NULL,
    signed_prekey_sig BLOB NOT NULL,
    created_at        INTEGER NOT NULL,
    last_seen_at      INTEGER NOT NULL DEFAULT 0,
    revoked           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- One-time prekeys, consumed on first contact for forward secrecy.
CREATE TABLE IF NOT EXISTS prekeys (
    id        TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    pub       BLOB NOT NULL,
    used      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prekeys_device ON prekeys(device_id, used);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id  TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- kind: 'dm' | 'group' | 'channel'
-- 'dm' and 'group' are always end-to-end encrypted.
-- 'channel' is the Mattermost-style open team channel: transport-encrypted,
--  server-searchable, optionally encrypted at rest.
--
-- A row with a non-empty parent_id is a *thread*: a sub-channel of a group with
-- its own membership list and therefore its own wrapped keys. Membership in the
-- parent grants nothing here; that is the whole point of the column.
CREATE TABLE IF NOT EXISTS channels (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    parent_id   TEXT NOT NULL DEFAULT '' REFERENCES channels(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL DEFAULT '',
    topic       TEXT NOT NULL DEFAULT '',
    avatar      TEXT NOT NULL DEFAULT '',   -- uploads.id
    owner_id    TEXT NOT NULL DEFAULT '',
    encrypted   INTEGER NOT NULL DEFAULT 1,
    suite       TEXT NOT NULL DEFAULT '',   -- may differ from the parent's
    created_at  INTEGER NOT NULL,
    last_seq    INTEGER NOT NULL DEFAULT 0,
    last_msg_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_channels_kind ON channels(kind);
CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_id);

CREATE TABLE IF NOT EXISTS memberships (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'member',
    joined_at  INTEGER NOT NULL,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    -- These three are one person's private view of the chat, not a property of
    -- the chat: archiving it for yourself must not archive it for anyone else.
    muted      INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    pinned     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

-- The server never sees `body` in cleartext for encrypted channels: it is the
-- suite's AEAD output. `header` carries the suite-specific public header
-- (ephemeral key, nonce, ratchet counters) and is also opaque to the server.
CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    sender_id   TEXT NOT NULL,
    sender_device TEXT NOT NULL DEFAULT '',
    suite       TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT 'text',
    header      BLOB,
    body        BLOB NOT NULL,
    reply_to    TEXT NOT NULL DEFAULT '',
    pinned      INTEGER NOT NULL DEFAULT 0,
    -- ids of rows in `uploads`. The *keys* for those files are not here: each
    -- file key travels inside the encrypted body above, so a leak of this table
    -- reveals which files exist, never how to read one.
    attachments TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    edited_at   INTEGER NOT NULL DEFAULT 0,
    deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(channel_id, created_at);

-- Per-recipient-device wrapped content keys. One row per device that may read
-- the message. Deleting the rows makes the message permanently unreadable,
-- which is how "delete for everyone" is implemented for E2E channels.
CREATE TABLE IF NOT EXISTS message_keys (
    message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL,
    wrapped_key BLOB NOT NULL,
    PRIMARY KEY (message_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_message_keys_device ON message_keys(device_id);

-- Files and avatars. kind='media' rows hold ciphertext produced by the sender's
-- suite; kind='avatar' rows hold a plaintext image (see docs/CRYPTO.md for why
-- that exception exists). width/height/duration are only what the sender
-- declared, kept so the layout can be reserved before decryption.
CREATE TABLE IF NOT EXISTS uploads (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL DEFAULT '',   -- '' for avatars
    kind       TEXT NOT NULL DEFAULT 'media',  -- 'media' | 'avatar'
    mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
    size       INTEGER NOT NULL,
    width      INTEGER NOT NULL DEFAULT 0,
    height     INTEGER NOT NULL DEFAULT 0,
    duration   INTEGER NOT NULL DEFAULT 0,
    data       BLOB NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_channel ON uploads(channel_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id         TEXT PRIMARY KEY,
    at         INTEGER NOT NULL,
    actor      TEXT NOT NULL DEFAULT '',
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
