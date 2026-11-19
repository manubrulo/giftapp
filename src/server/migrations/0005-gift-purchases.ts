import type Database from 'better-sqlite3';
import type { Migration } from '../migrations.js';

export const giftPurchasesMigration: Migration = {
  revision: '0005_gift_purchases',
  downRevision: '0004_gift_ideas',
  name: 'Track bought gifts and deleted wishlist entries',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE items ADD COLUMN deleted_at TEXT;
      ALTER TABLE items ADD COLUMN deleted_by_owner_name TEXT;
      CREATE TABLE item_purchases (
        item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        buyer_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
        buyer_name TEXT NOT NULL,
        buyer_avatar TEXT NOT NULL,
        purchased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX item_purchases_buyer_idx ON item_purchases(buyer_profile_id, purchased_at DESC);
    `);
  },
};
