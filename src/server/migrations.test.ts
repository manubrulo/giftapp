import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { runMigrations, TARGET_SCHEMA_REVISION, type Migration, type MigrationLogger } from './migrations.js';
import { lowercaseCategoriesMigration } from './migrations/0002-categories-lowercase.js';

function memoryDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

test('fresh database migrates to the image target and repeat startup is a no-op', () => {
  const db = memoryDb();
  const events: string[] = [];
  const logger: MigrationLogger = { info: (_fields, message) => events.push(message) };
  assert.equal(runMigrations(db, logger), TARGET_SCHEMA_REVISION);
  assert.equal(runMigrations(db, logger), TARGET_SCHEMA_REVISION);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profiles'").get());
  assert.equal(events.filter(event => event === 'Applying database migration').length, 5);
  assert.ok(events.includes('Database schema is current'));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_purchases'").get());
  db.close();
});

test('rejects unknown and newer database revisions without changing them', () => {
  for (const [revision, message] of [['unrecognized', /Unknown database revision/], ['9999_future', /newer than this image target/]] as const) {
    const db = memoryDb();
    db.exec('CREATE TABLE schema_revision (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision TEXT NOT NULL)');
    db.prepare('INSERT INTO schema_revision (singleton, revision) VALUES (1, ?)').run(revision);
    assert.throws(() => runMigrations(db), message);
    assert.equal((db.prepare('SELECT revision FROM schema_revision WHERE singleton = 1').get() as { revision: string }).revision, revision);
    db.close();
  }
});

test('migration failure rolls back its DDL and revision update', () => {
  const db = memoryDb();
  const failing: Migration = {
    revision: '0001_failure', downRevision: null, name: 'Fail after DDL',
    up(database) { database.exec('CREATE TABLE should_rollback (id INTEGER)'); throw new Error('intentional failure'); },
  };
  assert.throws(() => runMigrations(db, undefined, { migrations: [failing], targetRevision: failing.revision }), /intentional failure/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get(), undefined);
  assert.equal(db.prepare('SELECT revision FROM schema_revision WHERE singleton = 1').get(), undefined);
  db.close();
});

test('restart resumes after the last successfully committed revision', () => {
  const db = memoryDb();
  const first: Migration = { revision: '0001_first', downRevision: null, name: 'First', up(database) { database.exec('CREATE TABLE first_step (id INTEGER)'); } };
  const second: Migration = { revision: '0002_second', downRevision: first.revision, name: 'Second', up() { throw new Error('temporary failure'); } };
  assert.throws(() => runMigrations(db, undefined, { migrations: [first, second], targetRevision: second.revision }), /temporary failure/);
  assert.equal((db.prepare('SELECT revision FROM schema_revision WHERE singleton = 1').get() as { revision: string }).revision, first.revision);
  const resumed: Migration = { ...second, up(database) { database.exec('CREATE TABLE second_step (id INTEGER)'); } };
  assert.equal(runMigrations(db, undefined, { migrations: [first, resumed], targetRevision: resumed.revision }), resumed.revision);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'second_step'").get());
  db.close();
});

test('honors the legacy category migration marker during adoption', () => {
  const db = memoryDb();
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, category TEXT);
    CREATE TABLE app_migrations (name TEXT PRIMARY KEY);
    INSERT INTO items (id, category) VALUES (1, 'libros');
    INSERT INTO app_migrations (name) VALUES ('categories_lowercase_v1');
    CREATE TRIGGER prevent_category_rewrite BEFORE UPDATE ON items BEGIN SELECT RAISE(ABORT, 'must not rerun'); END;
  `);
  assert.doesNotThrow(() => lowercaseCategoriesMigration.up(db));
  assert.equal((db.prepare('SELECT category FROM items WHERE id = 1').get() as { category: string }).category, 'libros');
  db.close();
});
