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
`);

// Upgrade databases created before profile roles existed. Existing homes get
// one owner account so admin settings remain reachable after the upgrade.
const profileColumns = db.prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>;
if (!profileColumns.some(column => column.name === 'role')) {
  db.exec("ALTER TABLE profiles ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
}
if (!db.prepare("SELECT 1 FROM profiles WHERE role = 'admin' LIMIT 1").get()) {
  db.prepare("UPDATE profiles SET role = 'admin' WHERE id = (SELECT id FROM profiles ORDER BY created_at, id LIMIT 1)").run();
}
