PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS friends (
 id TEXT PRIMARY KEY,
 low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted')),
 created_at INTEGER NOT NULL,
 CHECK(low_id < high_id), CHECK(sender_id IN (low_id,high_id)),
 UNIQUE(low_id,high_id)
);
CREATE INDEX IF NOT EXISTS friends_low_status ON friends(low_id,status);
CREATE INDEX IF NOT EXISTS friends_high_status ON friends(high_id,status);
CREATE TABLE IF NOT EXISTS watch_invites (
 id TEXT PRIMARY KEY,
 sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 room_id TEXT NOT NULL,
 invite_token TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires INTEGER NOT NULL,
 CHECK(sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS watch_invites_sender_expiry ON watch_invites(sender_id,expires);
CREATE INDEX IF NOT EXISTS watch_invites_recipient_expiry ON watch_invites(recipient_id,expires);
CREATE INDEX IF NOT EXISTS watch_invites_expiry ON watch_invites(expires);
