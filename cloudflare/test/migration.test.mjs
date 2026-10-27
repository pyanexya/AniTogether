import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

test('initial schema can be applied again without deleting existing profiles', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const sql = readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO users (id, username, display_name, created_at) VALUES (?, ?, ?, ?)').run('00000000-0000-4000-8000-000000000001', 'kept', 'Preserved profile', 1);
    db.exec(sql);
    assert.equal(db.prepare('SELECT display_name FROM users WHERE username = ?').get('kept').display_name, 'Preserved profile');
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  } finally { db.close(); }
});
