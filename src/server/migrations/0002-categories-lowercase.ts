import type Database from 'better-sqlite3';
import type { Migration } from '../migrations.js';

export const lowercaseCategoriesMigration: Migration = {
  revision: '0002_categories_lowercase',
  downRevision: '0001_baseline',
  name: 'Normalize saved categories to lowercase',
  up(db: Database.Database) {
    const hasLegacyMigrations = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_migrations'").get();
    const alreadyNormalized = hasLegacyMigrations && !!db.prepare("SELECT 1 FROM app_migrations WHERE name = 'categories_lowercase_v1'").get();
    if (alreadyNormalized) return;

    const categories = db.prepare('SELECT id, category FROM items WHERE category IS NOT NULL').all() as Array<{ id: number; category: string }>;
    const update = db.prepare('UPDATE items SET category = ? WHERE id = ?');
    for (const { id, category } of categories) update.run(category.trim().toLowerCase() || null, id);
  },
};
