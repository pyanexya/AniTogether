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

test('friends migration is rerunnable, preserves auth/social data and cascades account deletion', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8'));
    const social = readFileSync(new URL('../migrations/0002_friends.sql', import.meta.url), 'utf8');
    for (const id of ['alice', 'bob']) db.prepare('INSERT INTO users(id,username,display_name,created_at) VALUES(?,?,?,?)').run(id,id,id,1);
    db.exec(social);
    db.exec("INSERT INTO friends VALUES('relation','alice','bob','alice','accepted',1); INSERT INTO watch_invites VALUES('invite','alice','bob','room','capability',1,300)");
    db.exec(social);
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
    assert.equal(db.prepare('SELECT status FROM friends').get().status, 'accepted');
    assert.equal(db.prepare('SELECT invite_token FROM watch_invites').get().invite_token, 'capability');
    db.exec("DELETE FROM users WHERE id='bob'");
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM friends').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM watch_invites').get().n, 0);
  } finally { db.close(); }
});
