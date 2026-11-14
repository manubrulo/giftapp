import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

const dir = process.env.DATA_DIR ?? './data';
mkdirSync(`${dir}/images`, { recursive: true });

export const db = new Database(`${dir}/regalos.db`);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  avatar TEXT NOT NULL DEFAULT '🙂',
  pin_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
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
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT,
  image_path TEXT,
  price REAL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  rating INTEGER NOT NULL DEFAULT 3 CHECK (rating BETWEEN 1 AND 5),
  notes TEXT,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS alternatives (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  url TEXT, title TEXT, price REAL, image_path TEXT, note TEXT
);
-- PRIVACIDAD: 'claims' NUNCA se consulta, une ni cuenta en ninguna ruta donde
-- quien pregunta sea el dueño del item (items.profile_id). Ni siquiera un booleano.
CREATE TABLE IF NOT EXISTS claims (
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_title TEXT NOT NULL,
  deleted_by TEXT NOT NULL DEFAULT 'El propietario',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const notificationColumns = db.prepare('PRAGMA table_info(notifications)').all() as Array<{ name: string }>;
if (!notificationColumns.some(column => column.name === 'deleted_by')) {
  db.exec("ALTER TABLE notifications ADD COLUMN deleted_by TEXT NOT NULL DEFAULT 'El propietario'");
}

// Upgrade databases created before profile roles existed. Existing homes get
// one owner account so admin settings remain reachable after the upgrade.
const profileColumns = db.prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>;
if (!profileColumns.some(column => column.name === 'role')) {
  db.exec("ALTER TABLE profiles ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
}
if (!db.prepare("SELECT 1 FROM profiles WHERE role = 'admin' LIMIT 1").get()) {
  db.prepare("UPDATE profiles SET role = 'admin' WHERE id = (SELECT id FROM profiles ORDER BY created_at, id LIMIT 1)").run();
}

// Existing installations retain their previous household-wide visibility.
// Profiles created after this one-time migration remain unassigned until an admin adds them.
if (!db.prepare("SELECT 1 FROM app_migrations WHERE name = 'families_v1'").get()) {
  const migrateFamilies = db.transaction(() => {
    const existingProfiles = db.prepare('SELECT id FROM profiles ORDER BY created_at, id').all() as Array<{ id: number }>;
    if (existingProfiles.length > 0) {
      db.prepare("INSERT OR IGNORE INTO families (name) VALUES ('Familia')").run();
      const family = db.prepare("SELECT id FROM families WHERE name = 'Familia'").get() as { id: number };
      const addMembership = db.prepare('INSERT OR IGNORE INTO family_memberships (family_id, profile_id) VALUES (?, ?)');
      for (const profile of existingProfiles) addMembership.run(family.id, profile.id);
    }
    db.prepare("INSERT INTO app_migrations (name) VALUES ('families_v1')").run();
  });
  migrateFamilies();
}
