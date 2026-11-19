import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = mkdtempSync(path.join(tmpdir(), 'regalos-migration-test-'));
const previousDataDir = process.env.DATA_DIR;
const previousNodeEnv = process.env.NODE_ENV;
const oldDb = new Database(path.join(dataDir, 'regalos.db'));
oldDb.exec(`
  CREATE TABLE profiles (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, avatar TEXT NOT NULL DEFAULT '🙂',
    pin_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE sessions (token TEXT PRIMARY KEY, profile_id INTEGER NOT NULL);
  CREATE TABLE items (id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, category TEXT);
  CREATE TABLE alternatives (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL);
  CREATE TABLE claims (item_id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL);
  CREATE TABLE notifications (id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, item_title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  INSERT INTO profiles (id, name) VALUES (1, 'Ana'), (2, 'Bea');
  INSERT INTO items (id, profile_id, category) VALUES (1, 1, 'Libros'), (2, 2, 'LIBROS');
`);
oldDb.close();
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
const [{ db }, { runMigrations, TARGET_SCHEMA_REVISION }] = await Promise.all([
  import('./db.js'), import('./migrations.js'),
]);
runMigrations(db);

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

test('adopts legacy databases, preserves household data, and reaches the target revision', () => {
  const family = db.prepare("SELECT id, name FROM families WHERE name = 'Familia'").get() as { id: number; name: string };
  assert.equal(family.name, 'Familia');
  assert.deepEqual(
    (db.prepare('SELECT profile_id FROM family_memberships WHERE family_id = ? ORDER BY profile_id').all(family.id) as Array<{ profile_id: number }>).map(row => row.profile_id),
    [1, 2],
  );
  assert.deepEqual(db.prepare('SELECT category FROM items ORDER BY id').all(), [{ category: 'libros' }, { category: 'libros' }]);
  assert.equal((db.prepare("SELECT role FROM profiles WHERE id = 1").get() as { role: string }).role, 'admin');
  assert.ok((db.prepare('PRAGMA table_info(notifications)').all() as Array<{ name: string }>).some(column => column.name === 'deleted_by'));
  assert.equal((db.prepare('SELECT revision FROM schema_revision WHERE singleton = 1').get() as { revision: string }).revision, TARGET_SCHEMA_REVISION);
});
