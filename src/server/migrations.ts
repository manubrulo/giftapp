import type Database from 'better-sqlite3';
import { baselineMigration } from './migrations/0001-baseline.js';
import { lowercaseCategoriesMigration } from './migrations/0002-categories-lowercase.js';
import { multipleLabelsMigration } from './migrations/0003-multiple-labels.js';
import { giftIdeasMigration } from './migrations/0004-gift-ideas.js';
import { giftPurchasesMigration } from './migrations/0005-gift-purchases.js';

export type Migration = {
  revision: string;
  downRevision: string | null;
  name: string;
  up: (db: Database.Database) => void;
};

export type MigrationLogger = {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
};

export const MIGRATIONS: Migration[] = [baselineMigration, lowercaseCategoriesMigration, multipleLabelsMigration, giftIdeasMigration, giftPurchasesMigration];
export const BASELINE_REVISION = baselineMigration.revision;
export const TARGET_SCHEMA_REVISION = giftPurchasesMigration.revision;

const silentLogger: MigrationLogger = { info: () => {} };
const revisionTableSql = `CREATE TABLE IF NOT EXISTS schema_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision TEXT NOT NULL
)`;

function tableExists(db: Database.Database, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnExists(db: Database.Database, table: string, column: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(row => row.name === column);
}

function hasLegacyApplicationTables(db: Database.Database) {
  return (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_revision' LIMIT 1").get()) != null;
}

// Shipped GiftApp versions predating schema_revision already upgraded databases
// through guarded DDL and app_migrations markers. Bring those databases to the
// 0.3.0 baseline once, then let the regular revision chain handle new changes.
function adoptLegacyDatabase(db: Database.Database) {
  const requiredTables = ['profiles', 'sessions', 'items', 'alternatives', 'claims', 'notifications'];
  const missing = requiredTables.filter(table => !tableExists(db, table));
  if (missing.length) {
    throw new Error(`Cannot adopt legacy database: missing required tables: ${missing.join(', ')}`);
  }

  const transaction = db.transaction(() => {
    const hadFamiliesTable = tableExists(db, 'families');
    const hadMembershipsTable = tableExists(db, 'family_memberships');
    const hasLegacyMigrations = tableExists(db, 'app_migrations');
    const hasFamiliesMarker = hasLegacyMigrations && !!db.prepare("SELECT 1 FROM app_migrations WHERE name = 'families_v1'").get();
    if (hasFamiliesMarker && (!hadFamiliesTable || !hadMembershipsTable)) {
      throw new Error('Cannot adopt legacy database: families_v1 is recorded but family tables are missing');
    }
    if (!columnExists(db, 'profiles', 'role')) {
      db.exec("ALTER TABLE profiles ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
    }
    if (!db.prepare("SELECT 1 FROM profiles WHERE role = 'admin' LIMIT 1").get()) {
      db.prepare("UPDATE profiles SET role = 'admin' WHERE id = (SELECT id FROM profiles ORDER BY created_at, id LIMIT 1)").run();
    }
    if (!columnExists(db, 'notifications', 'deleted_by')) {
      db.exec("ALTER TABLE notifications ADD COLUMN deleted_by TEXT NOT NULL DEFAULT 'El propietario'");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS families (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS family_memberships (
        family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (family_id, profile_id)
      );
      CREATE TABLE IF NOT EXISTS app_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    if (!hasFamiliesMarker) {
      db.prepare("INSERT OR IGNORE INTO families (name) VALUES ('Familia')").run();
      const family = db.prepare("SELECT id FROM families WHERE name = 'Familia'").get() as { id: number };
      db.prepare(`INSERT OR IGNORE INTO family_memberships (family_id, profile_id)
        SELECT ?, id FROM profiles`).run(family.id);
      db.prepare("INSERT INTO app_migrations (name) VALUES ('families_v1')").run();
    }

    db.prepare('INSERT INTO schema_revision (singleton, revision) VALUES (1, ?)').run(BASELINE_REVISION);
  });
  transaction();
}

function validateChain(migrations: Migration[], targetRevision: string) {
  if (!migrations.length || migrations.at(-1)?.revision !== targetRevision) {
    throw new Error(`Migration target ${targetRevision} must be the last registered migration`);
  }
  const seen = new Set<string>();
  let parent: string | null = null;
  for (const migration of migrations) {
    if (seen.has(migration.revision) || migration.downRevision !== parent) {
      throw new Error(`Invalid migration chain at revision ${migration.revision}`);
    }
    seen.add(migration.revision);
    parent = migration.revision;
  }
}

export function runMigrations(
  db: Database.Database,
  logger: MigrationLogger = silentLogger,
  options: { migrations?: Migration[]; targetRevision?: string } = {},
) {
  const migrations = options.migrations ?? MIGRATIONS;
  const targetRevision = options.targetRevision ?? TARGET_SCHEMA_REVISION;
  validateChain(migrations, targetRevision);
  db.exec(revisionTableSql);

  let current = (db.prepare('SELECT revision FROM schema_revision WHERE singleton = 1').get() as { revision: string } | undefined)?.revision ?? null;
  if (current === null && hasLegacyApplicationTables(db)) {
    adoptLegacyDatabase(db);
    current = BASELINE_REVISION;
    logger.info({ revision: current }, 'Adopted legacy database at baseline revision');
  }

  if (current === targetRevision) {
    logger.info({ currentRevision: current, targetRevision }, 'Database schema is current');
    return current;
  }

  if (current && !migrations.some(migration => migration.revision === current)) {
    const numericCurrent = Number(current.match(/^\d+/)?.[0]);
    const numericTarget = Number(targetRevision.match(/^\d+/)?.[0]);
    if (Number.isFinite(numericCurrent) && Number.isFinite(numericTarget) && numericCurrent > numericTarget) {
      throw new Error(`Database revision ${current} is newer than this image target ${targetRevision}; refusing to start an older image`);
    }
    throw new Error(`Unknown database revision ${current}; this image cannot safely migrate it`);
  }

  let next = migrations.find(migration => migration.downRevision === current);
  while (next) {
    const migration = next;
    logger.info({ revision: migration.revision, name: migration.name }, 'Applying database migration');
    const apply = db.transaction(() => {
      migration.up(db);
      if (current === null) {
        db.prepare('INSERT INTO schema_revision (singleton, revision) VALUES (1, ?)').run(migration.revision);
      } else {
        db.prepare('UPDATE schema_revision SET revision = ? WHERE singleton = 1').run(migration.revision);
      }
    });
    apply();
    current = migration.revision;
    logger.info({ revision: current }, 'Database migration applied');
    if (current === targetRevision) break;
    next = migrations.find(candidate => candidate.downRevision === current);
  }

  if (current !== targetRevision) {
    throw new Error(`No migration path from database revision ${current ?? 'empty'} to target ${targetRevision}`);
  }
  return current;
}
