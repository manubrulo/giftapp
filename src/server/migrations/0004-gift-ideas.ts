import type Database from 'better-sqlite3';
import type { Migration } from '../migrations.js';

export const giftIdeasMigration: Migration = {
  revision: '0004_gift_ideas',
  downRevision: '0003_multiple_labels',
  name: 'Add private gift ideas for other profiles',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE gift_ideas (
        id INTEGER PRIMARY KEY,
        owner_profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        recipient_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
        recipient_name TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        image_path TEXT,
        price REAL,
        currency TEXT NOT NULL DEFAULT 'EUR',
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX gift_ideas_owner_created_idx ON gift_ideas(owner_profile_id, created_at DESC, id DESC);
      CREATE INDEX gift_ideas_recipient_owner_idx ON gift_ideas(recipient_profile_id, owner_profile_id);
      CREATE TABLE idea_labels (
        idea_id INTEGER NOT NULL REFERENCES gift_ideas(id) ON DELETE CASCADE,
        label_name TEXT NOT NULL REFERENCES labels(name) ON DELETE CASCADE,
        PRIMARY KEY (idea_id, label_name)
      );
      CREATE INDEX idea_labels_label_name_idx ON idea_labels(label_name);
      CREATE TRIGGER gift_ideas_recipient_name_update
      AFTER UPDATE OF name ON profiles
      WHEN OLD.name <> NEW.name
      BEGIN
        UPDATE gift_ideas SET recipient_name = NEW.name WHERE recipient_profile_id = NEW.id;
      END;
    `);
  },
};
