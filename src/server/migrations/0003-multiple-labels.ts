import type Database from 'better-sqlite3';
import type { Migration } from '../migrations.js';
import { allocateLabelColor } from '../../shared/label-colors.js';

export const multipleLabelsMigration: Migration = {
  revision: '0003_multiple_labels',
  downRevision: '0002_categories_lowercase',
  name: 'Add colored labels and allow multiple labels per wish',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE labels (
        name TEXT PRIMARY KEY,
        color TEXT NOT NULL
      );
      CREATE TABLE item_labels (
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        label_name TEXT NOT NULL REFERENCES labels(name) ON DELETE CASCADE,
        PRIMARY KEY (item_id, label_name)
      );
      CREATE INDEX item_labels_label_name_idx ON item_labels(label_name);
    `);

    const items = db.prepare('SELECT id, category FROM items WHERE category IS NOT NULL ORDER BY category COLLATE NOCASE, id').all() as Array<{ id: number; category: string }>;
    const findLabel = db.prepare('SELECT 1 FROM labels WHERE name = ?');
    const addLabel = db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)');
    const addItemLabel = db.prepare('INSERT OR IGNORE INTO item_labels (item_id, label_name) VALUES (?, ?)');
    const getUsedColors = db.prepare('SELECT color FROM labels');
    for (const { id, category } of items) {
      const name = category.trim().toLowerCase();
      if (!name) continue;
      if (!findLabel.get(name)) {
        const used = getUsedColors.all() as Array<{ color: string }>;
        addLabel.run(name, allocateLabelColor(name, used.map(row => row.color)));
      }
      addItemLabel.run(id, name);
    }
  },
};
