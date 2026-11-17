import type Database from 'better-sqlite3';
import type { Migration } from '../migrations.js';

export const baselineMigration: Migration = {
  revision: '0001_baseline',
  downRevision: null,
  name: 'Create GiftApp baseline schema',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE profiles (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        avatar TEXT NOT NULL DEFAULT '🙂',
        pin_hash TEXT,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE families (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE family_memberships (
        family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (family_id, profile_id)
      );
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE items (
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
      CREATE TABLE alternatives (
        id INTEGER PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        url TEXT, title TEXT, price REAL, image_path TEXT, note TEXT
      );
      CREATE TABLE claims (
        item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE
      );
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        item_title TEXT NOT NULL,
        deleted_by TEXT NOT NULL DEFAULT 'El propietario',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  },
};
