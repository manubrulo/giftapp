import type Database from 'better-sqlite3';

export const LABEL_COLOR_IDS = [
  'rose', 'orange', 'amber', 'lime', 'emerald', 'teal',
  'sky', 'blue', 'indigo', 'violet', 'fuchsia', 'slate',
] as const;

export type LabelColor = typeof LABEL_COLOR_IDS[number];

export function allocateLabelColor(name: string, usedColors: Iterable<string>): LabelColor {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  const used = new Set(usedColors);
  const start = hash % LABEL_COLOR_IDS.length;
  for (let offset = 0; offset < LABEL_COLOR_IDS.length; offset++) {
    const color = LABEL_COLOR_IDS[(start + offset) % LABEL_COLOR_IDS.length];
    if (!used.has(color)) return color;
  }
  return LABEL_COLOR_IDS[start];
}

export function allocateLabelColorFromDatabase(db: Database.Database, name: string): LabelColor {
  const used = db.prepare('SELECT color FROM labels').all() as Array<{ color: string }>;
  return allocateLabelColor(name, used.map(row => row.color));
}
