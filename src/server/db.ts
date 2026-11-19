import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

const dir = process.env.DATA_DIR ?? './data';
mkdirSync(`${dir}/images`, { recursive: true });

export const db = new Database(`${dir}/regalos.db`);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
