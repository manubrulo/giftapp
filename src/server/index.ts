import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { runMigrations, TARGET_SCHEMA_REVISION } from './migrations.js';
import { createLoggerOptions } from './logging.js';
import { importImageFromUrl, saveUploadedImage, scrapeProduct } from './scrape.js';
import { allocateLabelColorFromDatabase } from '../shared/label-colors.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const BASE_PATH = (process.env.BASE_PATH ?? '').trim().replace(/\/+$/, '');
if (BASE_PATH && (!BASE_PATH.startsWith('/') || BASE_PATH.includes('?') || BASE_PATH.includes('#'))) {
  throw new Error('BASE_PATH must be an absolute URL path such as /giftapp');
}
mkdirSync(IMAGE_DIR, { recursive: true });

// --- PIN (scrypt, sin dependencias) ---
const hashPin = (pin: string) => {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pin, salt, 32).toString('hex')}`;
};
const checkPin = (pin: string, stored: string) => {
  try {
    const [saltHex, keyHex] = stored.split(':');
    const key = Buffer.from(keyHex, 'hex');
    return key.length === 32 && timingSafeEqual(scryptSync(pin, Buffer.from(saltHex, 'hex'), 32), key);
  } catch { return false; }
};

// Bloqueo simple: 5 fallos => 1 minuto.
const locks = new Map<number, { n: number; until: number }>();
const parsePriceInput = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^\d+(?:[.,]\d+)?$/.test(value.trim())) return NaN;
  return Number(value.trim().replace(',', '.'));
};

type Profile = { id: number; name: string; avatar: string; pin_hash: string | null; role: 'member' | 'admin' };
const publicProfile = (p: Profile) => ({ id: p.id, name: p.name, avatar: p.avatar, hasPin: !!p.pin_hash, role: p.role });
const positiveId = (value: unknown) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const sessionProfile = (req: FastifyRequest): Profile | undefined => {
  const token = req.cookies.sid;
  return token ? db.prepare('SELECT p.* FROM sessions s JOIN profiles p ON p.id = s.profile_id WHERE s.token = ?').get(token) as Profile | undefined : undefined;
};
const fallbackItemTitle = (url: string | null) => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const slug = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? '')
      .replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim();
    // Opaque product IDs and host names are not useful gift names; require a
    // product title from the preview or a manually entered name instead.
    return slug && !/^[a-z0-9]{6,}$/i.test(slug) && !/^(products?|items?|p)$/i.test(slug)
      ? slug.slice(0, 200)
      : null;
  } catch { return null; }
};
const requireProfile = (req: FastifyRequest, reply: FastifyReply): Profile | undefined => {
  const me = sessionProfile(req);
  if (!me) reply.code(401).send({ error: 'Inicia sesión para continuar' });
  return me;
};
const requireAdmin = (req: FastifyRequest, reply: FastifyReply): Profile | undefined => {
  const me = requireProfile(req, reply);
  if (me && me.role !== 'admin') reply.code(403).send({ error: 'Solo un administrador puede hacer eso' });
  return me?.role === 'admin' ? me : undefined;
};
const profilesShareFamily = (firstProfileId: number, secondProfileId: number) => !!db.prepare(`
  SELECT 1 FROM family_memberships mine
  JOIN family_memberships theirs ON theirs.family_id = mine.family_id
  WHERE mine.profile_id = ? AND theirs.profile_id = ? LIMIT 1
`).get(firstProfileId, secondProfileId);

type ItemInput = {
  title?: unknown; url?: unknown; imagePath?: unknown; price?: unknown; currency?: unknown;
  rating?: unknown; notes?: unknown; category?: unknown; labels?: unknown;
};
type GiftIdeaInput = {
  title?: unknown; url?: unknown; imagePath?: unknown; price?: unknown; currency?: unknown;
  notes?: unknown; labels?: unknown;
};
const itemFields = (input: ItemInput, partial = false) => {
  const errors: string[] = [];
  const text = (value: unknown, max: number, label: string, required = false): string | null => {
    if (value === undefined && partial) return null;
    if (value === undefined || value === null || value === '') {
      if (required) errors.push(`${label} es obligatorio`);
      return null;
    }
    if (typeof value !== 'string' || value.length > max) { errors.push(`${label} no es válido`); return null; }
    const trimmed = value.trim();
    if (required && !trimmed) errors.push(`${label} es obligatorio`);
    return trimmed || null;
  };
  let title = text(input.title, 200, 'El título');
  const url = text(input.url, 2048, 'El enlace');
  const imagePath = text(input.imagePath, 500, 'La imagen');
  const notes = text(input.notes, 2000, 'Las notas');
  let labels: string[] | null = null;
  let labelsInput: unknown;
  if (input.labels !== undefined) labelsInput = input.labels === null ? [] : input.labels;
  else if (input.category !== undefined) labelsInput = input.category === null ? [] : [input.category];
  else labelsInput = partial ? null : [];
  if (labelsInput !== null) {
    if (!Array.isArray(labelsInput)) {
      errors.push('Las etiquetas no son válidas');
      labels = [];
    } else {
      labels = [];
      for (const value of labelsInput) {
        if (typeof value !== 'string' || value.length > 60) {
          errors.push('Una etiqueta no es válida');
          continue;
        }
        const normalized = value.trim().toLowerCase();
        if (normalized && !labels.includes(normalized)) labels.push(normalized);
      }
    }
  }
  const category = labels === null ? null : labels[0] ?? null;
  const currency = (text(input.currency, 3, 'La moneda') ?? 'EUR').toUpperCase();
  const price = input.price === undefined && partial ? null : parsePriceInput(input.price);
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 1_000_000_000)) errors.push('El precio no es válido');
  const rating = input.rating === undefined && partial ? null : input.rating == null || input.rating === '' ? 3 : Number(input.rating);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) errors.push('La valoración debe estar entre 1 y 5');
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('La moneda debe tener 3 letras');
  if (url) { try { if (!['http:', 'https:'].includes(new URL(url).protocol)) errors.push('El enlace debe empezar por http o https'); } catch { errors.push('El enlace no es válido'); } }
  if (!partial && !title) title = fallbackItemTitle(url);
  if (!partial && !title) errors.push('Añade un nombre o usa Buscar para obtenerlo del enlace');
  if (imagePath && !imagePath.startsWith('/images/')) errors.push('La imagen no es válida');
  return { errors, fields: { title, url, imagePath, price, currency, rating, notes, category, labels } };
};

const giftIdeaFields = (input: GiftIdeaInput) => {
  const errors: string[] = [];
  const text = (value: unknown, max: number, label: string): string | null => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > max) { errors.push(`${label} no es válido`); return null; }
    return value.trim() || null;
  };
  const url = text(input.url, 2048, 'El enlace');
  const imagePath = text(input.imagePath, 500, 'La imagen');
  const notes = text(input.notes, 2000, 'Las notas');
  let title = text(input.title, 200, 'El título');
  if (!title) title = fallbackItemTitle(url);
  if (!title) errors.push('Añade un nombre o usa Buscar para obtenerlo del enlace');
  if (url) { try { if (!['http:', 'https:'].includes(new URL(url).protocol)) errors.push('El enlace debe empezar por http o https'); } catch { errors.push('El enlace no es válido'); } }
  if (imagePath && !imagePath.startsWith('/images/')) errors.push('La imagen no es válida');

  const currency = (text(input.currency, 3, 'La moneda') ?? 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('La moneda debe tener 3 letras');
  const price = parsePriceInput(input.price);
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 1_000_000_000)) errors.push('El precio no es válido');

  const labels: string[] = [];
  const labelsInput = input.labels ?? [];
  if (!Array.isArray(labelsInput)) errors.push('Las etiquetas no son válidas');
  else for (const value of labelsInput) {
    if (typeof value !== 'string' || value.length > 60) {
      errors.push('Una etiqueta no es válida');
      continue;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized && !labels.includes(normalized)) labels.push(normalized);
  }
  return { errors, fields: { title, url, imagePath, price, currency, notes, labels } };
};

const publicItem = (row: any, viewer = false) => ({
  id: row.id, profileId: row.profile_id, title: row.title, url: row.url,
  imagePath: row.image_path, price: row.price, currency: row.currency,
  rating: row.rating, notes: row.notes, category: row.labels?.[0]?.name ?? row.category,
  labels: row.labels ?? [], createdAt: row.created_at,
  alternatives: row.alternatives ?? [],
  ...(Object.hasOwn(row, 'claim_profile_id') ? {
    reservedBy: row.claim_profile_id ? { id: row.claim_profile_id, name: row.claim_profile_name, avatar: row.claim_profile_avatar } : null,
  } : {}),
  ...(viewer && Object.hasOwn(row, 'purchase_item_id') ? {
    boughtAt: row.purchase_item_id ? row.purchased_at : null,
    boughtBy: row.purchase_item_id ? { name: row.buyer_name, avatar: row.buyer_avatar } : null,
    ownerDeleted: !!row.deleted_at,
    deletedByOwnerName: row.deleted_by_owner_name ?? null,
  } : {}),
});
const alternativesFor = (itemId: number) => db.prepare('SELECT id, url, title, price, image_path as imagePath, note FROM alternatives WHERE item_id = ? ORDER BY id').all(itemId);
const labelsForItem = (itemId: number) => db.prepare(`SELECT l.name, l.color FROM labels l
  JOIN item_labels il ON il.label_name = l.name WHERE il.item_id = ? ORDER BY l.name COLLATE NOCASE`).all(itemId) as Array<{ name: string; color: string }>;
const replaceItemLabels = (itemId: number, names: string[]) => {
  const remove = db.prepare('DELETE FROM item_labels WHERE item_id = ?');
  const find = db.prepare('SELECT 1 FROM labels WHERE name = ?');
  const add = db.prepare('INSERT INTO item_labels (item_id, label_name) VALUES (?, ?)');
  const create = db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)');
  const insert = db.transaction(() => {
    remove.run(itemId);
    for (const name of names) {
      if (!find.get(name)) create.run(name, allocateLabelColorFromDatabase(db, name));
      add.run(itemId, name);
    }
  });
  insert();
};
const replaceIdeaLabels = (ideaId: number, names: string[]) => {
  const remove = db.prepare('DELETE FROM idea_labels WHERE idea_id = ?');
  const find = db.prepare('SELECT 1 FROM labels WHERE name = ?');
  const add = db.prepare('INSERT INTO idea_labels (idea_id, label_name) VALUES (?, ?)');
  const create = db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)');
  const insert = db.transaction(() => {
    remove.run(ideaId);
    for (const name of names) {
      if (!find.get(name)) create.run(name, allocateLabelColorFromDatabase(db, name));
      add.run(ideaId, name);
    }
  });
  insert();
};
const labelsForIdea = (ideaId: number) => db.prepare(`SELECT l.name, l.color FROM labels l
  JOIN idea_labels il ON il.label_name = l.name WHERE il.idea_id = ? ORDER BY l.name COLLATE NOCASE`).all(ideaId) as Array<{ name: string; color: string }>;
const publicIdea = (row: any) => ({
  id: row.id,
  recipientProfileId: row.recipient_profile_id,
  recipientName: row.recipient_name,
  title: row.title,
  url: row.url,
  imagePath: row.image_path,
  price: row.price,
  currency: row.currency,
  notes: row.notes,
  labels: row.labels ?? [],
  createdAt: row.created_at,
});
const myIdeas = (ownerProfileId: number) => {
  const rows = db.prepare('SELECT * FROM gift_ideas WHERE owner_profile_id = ? ORDER BY created_at DESC, id DESC').all(ownerProfileId) as any[];
  return rows.map(row => publicIdea({ ...row, labels: labelsForIdea(row.id) }));
};
const ideasForRecipient = (ownerProfileId: number, recipientProfileId: number) => {
  const rows = db.prepare(`SELECT * FROM gift_ideas
    WHERE owner_profile_id = ? AND recipient_profile_id = ? ORDER BY created_at DESC, id DESC`).all(ownerProfileId, recipientProfileId) as any[];
  return rows.map(row => publicIdea({ ...row, labels: labelsForIdea(row.id) }));
};
const notifyBuyerBeforeItemDelete = (itemId: number, itemTitle: string, ownerId: number, ownerName: string) => {
  const claim = db.prepare('SELECT profile_id FROM claims WHERE item_id = ?').get(itemId) as { profile_id: number } | undefined;
  if (claim && claim.profile_id !== ownerId) {
    db.prepare('INSERT INTO notifications (profile_id, item_title, deleted_by) VALUES (?, ?, ?)').run(claim.profile_id, itemTitle, ownerName);
  }
};
const myItems = (profileId: number) => {
  // PRIVACY: this owner-only query deliberately never reads the claims table.
  // It also deliberately omits purchase records to preserve the surprise.
  const rows = db.prepare('SELECT * FROM items WHERE profile_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC').all(profileId) as any[];
  return rows.map(row => publicItem({ ...row, alternatives: alternativesFor(row.id), labels: labelsForItem(row.id) }));
};
const viewedItems = (profileId: number) => {
  const rows = db.prepare(`SELECT i.*, c.profile_id AS claim_profile_id,
      buyer.name AS claim_profile_name, buyer.avatar AS claim_profile_avatar,
      purchase.item_id AS purchase_item_id, purchase.buyer_name, purchase.buyer_avatar,
      purchase.purchased_at
    FROM items i LEFT JOIN claims c ON c.item_id = i.id
    LEFT JOIN profiles buyer ON buyer.id = c.profile_id
    LEFT JOIN item_purchases purchase ON purchase.item_id = i.id
    WHERE i.profile_id = ? ORDER BY i.created_at DESC, i.id DESC`).all(profileId) as any[];
  return rows.map(row => publicItem({ ...row, alternatives: alternativesFor(row.id), labels: labelsForItem(row.id) }, true));
};
const boughtItemsFor = (buyerProfileId: number) => {
  const rows = db.prepare(`SELECT i.*, owner.name AS owner_name, owner.avatar AS owner_avatar,
      purchase.item_id AS purchase_item_id, purchase.buyer_name, purchase.buyer_avatar, purchase.purchased_at
    FROM item_purchases purchase JOIN items i ON i.id = purchase.item_id
    JOIN profiles owner ON owner.id = i.profile_id
    WHERE purchase.buyer_profile_id = ? ORDER BY purchase.purchased_at DESC, i.id DESC`).all(buyerProfileId) as any[];
  return rows.map(row => ({
    ...publicItem({ ...row, labels: labelsForItem(row.id), alternatives: alternativesFor(row.id) }, true),
    ownerName: row.owner_name,
    ownerAvatar: row.owner_avatar,
  }));
};

function isConstraintError(error: unknown) {
  return error instanceof Error && /constraint/i.test(error.message);
}

export async function buildApp() {
  const app = Fastify({
    logger: createLoggerOptions(),
    bodyLimit: 2 * 1024 * 1024,
    rewriteUrl: request => {
      const url = request.url ?? '/';
      return BASE_PATH && (url === BASE_PATH || url.startsWith(`${BASE_PATH}/`))
        ? url.slice(BASE_PATH.length) || '/'
        : url;
    },
  });
  try {
    runMigrations(db, app.log);
  } catch (error) {
    app.log.fatal({ err: error }, 'Database migration failed; refusing startup');
    await app.close();
    throw error;
  }
  app.addHook('onError', async (request, reply, error) => {
    request.log.error({ err: error, statusCode: reply.statusCode, route: request.routeOptions.url }, 'Request failed');
  });
  await app.register(cookie);

  app.get('/api/profiles', async () =>
    (db.prepare('SELECT * FROM profiles ORDER BY name').all() as Profile[]).map(publicProfile));

  app.get('/api/profiles/visible', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    return (db.prepare(`SELECT DISTINCT p.* FROM profiles p
      LEFT JOIN family_memberships mine ON mine.profile_id = ?
      LEFT JOIN family_memberships their ON their.family_id = mine.family_id AND their.profile_id = p.id
      WHERE p.id = ? OR their.profile_id IS NOT NULL ORDER BY p.name`).all(me.id, me.id) as Profile[]).map(publicProfile);
  });

  app.post('/api/profiles', async (req, reply) => {
    const { name, avatar, pin } = (req.body ?? {}) as any;
    const n = String(name ?? '').trim();
    if (!n || n.length > 30) return reply.code(400).send({ error: 'El nombre debe tener entre 1 y 30 caracteres' });
    if (pin != null && pin !== '' && !/^\d{4,8}$/.test(String(pin))) return reply.code(400).send({ error: 'El PIN debe tener de 4 a 8 dígitos' });
    try {
      const isFirstProfile = !db.prepare('SELECT 1 FROM profiles LIMIT 1').get();
      const r = db.prepare('INSERT INTO profiles (name, avatar, pin_hash, role) VALUES (?, ?, ?, ?)')
        .run(n, String(avatar || '🙂').slice(0, 8), pin ? hashPin(String(pin)) : null, isFirstProfile ? 'admin' : 'member');
      const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(r.lastInsertRowid) as Profile;
      startSession(reply, Number(r.lastInsertRowid));
      return { me: publicProfile(p) };
    } catch (error) {
      if (isConstraintError(error)) return reply.code(409).send({ error: 'Ya existe un perfil con ese nombre' });
      throw error;
    }
  });

  app.post('/api/login', async (req, reply) => {
    const { profileId, pin } = (req.body ?? {}) as any;
    const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as Profile | undefined;
    if (!p) return reply.code(404).send({ error: 'Perfil no encontrado' });
    if (p.pin_hash) {
      const lock = locks.get(p.id);
      if (lock && lock.until > Date.now()) return reply.code(429).send({ error: 'Demasiados intentos. Espera un minuto.' });
      if (!/^\d{4,8}$/.test(String(pin ?? '')) || !checkPin(String(pin), p.pin_hash)) {
        const n = (lock?.n ?? 0) + 1;
        locks.set(p.id, n >= 5 ? { n: 0, until: Date.now() + 60_000 } : { n, until: 0 });
        return reply.code(401).send({ error: 'PIN incorrecto' });
      }
      locks.delete(p.id);
    }
    startSession(reply, p.id);
    return { me: publicProfile(p) };
  });

  app.post('/api/logout', async (req, reply) => {
    if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
    reply.clearCookie('sid', { path: BASE_PATH || '/' });
    return { ok: true };
  });
  app.get('/api/me', async req => {
    const p = sessionProfile(req);
    return { me: p ? publicProfile(p) : null };
  });

  app.get('/api/notifications', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    return db.prepare('SELECT id, item_title AS itemTitle, deleted_by AS deletedBy, created_at AS createdAt FROM notifications WHERE profile_id = ? ORDER BY id DESC').all(me.id);
  });

  app.delete('/api/notifications/:notificationId', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const id = positiveId((req.params as any).notificationId);
    if (id === null) return reply.code(400).send({ error: 'Aviso no válido' });
    const result = db.prepare('DELETE FROM notifications WHERE id = ? AND profile_id = ?').run(id, me.id);
    if (!result.changes) return reply.code(404).send({ error: 'No encontramos ese aviso' });
    return { ok: true };
  });

  app.put('/api/me/profile', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as any;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const avatar = typeof body.avatar === 'string' ? body.avatar.trim() : '';
    if (!name || name.length > 30) return reply.code(400).send({ error: 'El nombre debe tener entre 1 y 30 caracteres' });
    if (!avatar || avatar.length > 8) return reply.code(400).send({ error: 'El avatar no es válido' });
    let pinHash = me.pin_hash;
    if (body.pin !== undefined) {
      if (body.pin === null || body.pin === '') pinHash = null;
      else if (typeof body.pin !== 'string' || !/^\d{4,8}$/.test(body.pin)) return reply.code(400).send({ error: 'El PIN debe tener de 4 a 8 dígitos' });
      else pinHash = hashPin(body.pin);
    }
    try {
      db.prepare('UPDATE profiles SET name = ?, avatar = ?, pin_hash = ? WHERE id = ?').run(name, avatar, pinHash, me.id);
      return { me: publicProfile(db.prepare('SELECT * FROM profiles WHERE id = ?').get(me.id) as Profile) };
    } catch (error) {
      if (isConstraintError(error)) return reply.code(409).send({ error: 'Ya existe un perfil con ese nombre' });
      throw error;
    }
  });

  app.delete('/api/items/mine', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const items = db.prepare(`SELECT i.id, i.title, EXISTS(
      SELECT 1 FROM item_purchases purchase WHERE purchase.item_id = i.id
    ) AS purchased FROM items i WHERE i.profile_id = ? AND i.deleted_at IS NULL`).all(me.id) as Array<{ id: number; title: string; purchased: number }>;
    const remove = db.transaction(() => {
      for (const item of items) notifyBuyerBeforeItemDelete(item.id, item.title, me.id, me.name);
      const retain = db.prepare('UPDATE items SET deleted_at = CURRENT_TIMESTAMP, deleted_by_owner_name = ? WHERE id = ? AND profile_id = ?');
      const erase = db.prepare('DELETE FROM items WHERE id = ? AND profile_id = ?');
      for (const item of items) item.purchased ? retain.run(me.name, item.id, me.id) : erase.run(item.id, me.id);
      return items.length;
    });
    return { ok: true, deleted: remove() };
  });

  app.post('/api/items/mine/delete-selected', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const itemIds = (req.body as any)?.itemIds;
    if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 500
      || itemIds.some(id => !Number.isSafeInteger(id) || id <= 0)
      || new Set(itemIds).size !== itemIds.length) {
      return reply.code(400).send({ error: 'Selecciona entre 1 y 500 deseos válidos' });
    }
    const placeholders = itemIds.map(() => '?').join(', ');
    const owned = Number((db.prepare(`SELECT COUNT(*) AS count FROM items WHERE profile_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`).get(me.id, ...itemIds) as any).count);
    if (owned !== itemIds.length) return reply.code(404).send({ error: 'Uno o más deseos ya no están disponibles en tu lista' });
    const selectedItems = db.prepare(`SELECT i.id, i.title, EXISTS(
      SELECT 1 FROM item_purchases purchase WHERE purchase.item_id = i.id
    ) AS purchased FROM items i WHERE i.profile_id = ? AND i.deleted_at IS NULL AND i.id IN (${placeholders})`).all(me.id, ...itemIds) as Array<{ id: number; title: string; purchased: number }>;
    const remove = db.transaction(() => {
      for (const item of selectedItems) notifyBuyerBeforeItemDelete(item.id, item.title, me.id, me.name);
      const retain = db.prepare('UPDATE items SET deleted_at = CURRENT_TIMESTAMP, deleted_by_owner_name = ? WHERE id = ? AND profile_id = ?');
      const erase = db.prepare('DELETE FROM items WHERE id = ? AND profile_id = ?');
      for (const item of selectedItems) item.purchased ? retain.run(me.name, item.id, me.id) : erase.run(item.id, me.id);
      return selectedItems.length;
    });
    return { ok: true, deleted: remove() };
  });

  app.get('/api/purchases/mine', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    return boughtItemsFor(me.id);
  });

  app.get('/api/admin/profiles', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return db.prepare(`SELECT p.id, p.name, p.avatar, p.role, p.pin_hash IS NOT NULL AS hasPin, p.created_at AS createdAt,
      (SELECT COUNT(*) FROM items i WHERE i.profile_id = p.id AND i.deleted_at IS NULL) AS itemCount
      FROM profiles p ORDER BY p.created_at, p.id`).all();
  });

  app.get('/api/admin/families', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return (db.prepare('SELECT id, name, created_at AS createdAt FROM families ORDER BY name COLLATE NOCASE, id').all() as Array<{ id: number; name: string; createdAt: string }>).map(family => ({
      ...family,
      profileIds: (db.prepare('SELECT profile_id FROM family_memberships WHERE family_id = ? ORDER BY profile_id').all(family.id) as Array<{ profile_id: number }>).map(row => row.profile_id),
    }));
  });

  app.post('/api/admin/families', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const name = typeof (req.body as any)?.name === 'string' ? (req.body as any).name.trim() : '';
    if (!name || name.length > 60) return reply.code(400).send({ error: 'El nombre de la familia debe tener entre 1 y 60 caracteres' });
    try {
      const result = db.prepare('INSERT INTO families (name) VALUES (?)').run(name);
      return reply.code(201).send({ id: Number(result.lastInsertRowid), name, profileIds: [] });
    } catch (error) {
      if (isConstraintError(error)) return reply.code(409).send({ error: 'Ya existe una familia con ese nombre' });
      throw error;
    }
  });

  app.put('/api/admin/families/:familyId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = positiveId((req.params as any).familyId);
    if (id === null) return reply.code(400).send({ error: 'Familia no válida' });
    const family = db.prepare('SELECT id, name FROM families WHERE id = ?').get(id) as { id: number; name: string } | undefined;
    if (!family) return reply.code(404).send({ error: 'Familia no encontrada' });
    const body = (req.body ?? {}) as any;
    const name = body.name === undefined ? family.name : typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) return reply.code(400).send({ error: 'El nombre de la familia debe tener entre 1 y 60 caracteres' });
    let profileIds: number[] | undefined;
    if (body.profileIds !== undefined) {
      if (!Array.isArray(body.profileIds) || body.profileIds.some((value: unknown) => !Number.isSafeInteger(value) || Number(value) <= 0)
        || new Set(body.profileIds).size !== body.profileIds.length) return reply.code(400).send({ error: 'La lista de perfiles no es válida' });
      const requestedProfileIds = body.profileIds as number[];
      profileIds = requestedProfileIds;
      const placeholders = requestedProfileIds.map(() => '?').join(', ');
      const count = requestedProfileIds.length ? Number((db.prepare(`SELECT COUNT(*) AS n FROM profiles WHERE id IN (${placeholders})`).get(...requestedProfileIds) as any).n) : 0;
      if (count !== requestedProfileIds.length) return reply.code(400).send({ error: 'Uno o más perfiles no existen' });
    }
    try {
      const update = db.transaction(() => {
        db.prepare('UPDATE families SET name = ? WHERE id = ?').run(name, id);
        if (profileIds) {
          db.prepare('DELETE FROM family_memberships WHERE family_id = ?').run(id);
          const add = db.prepare('INSERT INTO family_memberships (family_id, profile_id) VALUES (?, ?)');
          for (const profileId of profileIds) add.run(id, profileId);
        }
      });
      update();
    } catch (error) {
      if (isConstraintError(error)) return reply.code(409).send({ error: 'Ya existe una familia con ese nombre' });
      throw error;
    }
    return { id, name, profileIds: profileIds ?? (db.prepare('SELECT profile_id FROM family_memberships WHERE family_id = ? ORDER BY profile_id').all(id) as Array<{ profile_id: number }>).map(row => row.profile_id) };
  });

  app.delete('/api/admin/families/:familyId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = positiveId((req.params as any).familyId);
    if (id === null) return reply.code(400).send({ error: 'Familia no válida' });
    const result = db.prepare('DELETE FROM families WHERE id = ?').run(id);
    if (!result.changes) return reply.code(404).send({ error: 'Familia no encontrada' });
    return { ok: true };
  });

  app.put('/api/admin/profiles/:profileId', async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return;
    const id = positiveId((req.params as any).profileId);
    if (id === null) return reply.code(400).send({ error: 'Perfil no válido' });
    const target = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile | undefined;
    if (!target) return reply.code(404).send({ error: 'Perfil no encontrado' });
    const body = (req.body ?? {}) as any;
    const name = body.name === undefined ? target.name : typeof body.name === 'string' ? body.name.trim() : '';
    const avatar = body.avatar === undefined ? target.avatar : typeof body.avatar === 'string' ? body.avatar.trim() : '';
    const role = body.role === undefined ? target.role : body.role;
    if (!name || name.length > 30) return reply.code(400).send({ error: 'El nombre debe tener entre 1 y 30 caracteres' });
    if (!avatar || avatar.length > 8) return reply.code(400).send({ error: 'El avatar no es válido' });
    if (role !== 'admin' && role !== 'member') return reply.code(400).send({ error: 'El rol no es válido' });
    if (id === admin.id && role !== 'admin') return reply.code(400).send({ error: 'No puedes quitarte tu propio rol de administrador' });
    if (target.role === 'admin' && role !== 'admin' && Number((db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE role = 'admin'").get() as any).n) <= 1) {
      return reply.code(400).send({ error: 'Debe quedar al menos un administrador' });
    }
    let pinHash = target.pin_hash;
    if (body.pin !== undefined) {
      if (body.pin === null || body.pin === '') pinHash = null;
      else if (typeof body.pin !== 'string' || !/^\d{4,8}$/.test(body.pin)) return reply.code(400).send({ error: 'El PIN debe tener de 4 a 8 dígitos' });
      else pinHash = hashPin(body.pin);
    }
    try {
      db.prepare('UPDATE profiles SET name = ?, avatar = ?, role = ?, pin_hash = ? WHERE id = ?').run(name, avatar, role, pinHash, id);
      const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile;
      return { ...publicProfile(profile), itemCount: Number((db.prepare('SELECT COUNT(*) AS n FROM items WHERE profile_id = ? AND deleted_at IS NULL').get(id) as any).n) };
    } catch (error) {
      if (isConstraintError(error)) return reply.code(409).send({ error: 'Ya existe un perfil con ese nombre' });
      throw error;
    }
  });

  app.delete('/api/admin/profiles/:profileId', async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return;
    const id = positiveId((req.params as any).profileId);
    if (id === null) return reply.code(400).send({ error: 'Perfil no válido' });
    if (id === admin.id) return reply.code(400).send({ error: 'No puedes borrar tu propio perfil desde aquí' });
    const target = db.prepare('SELECT role FROM profiles WHERE id = ?').get(id) as { role: string } | undefined;
    if (!target) return reply.code(404).send({ error: 'Perfil no encontrado' });
    if (target.role === 'admin' && Number((db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE role = 'admin'").get() as any).n) <= 1) {
      return reply.code(400).send({ error: 'Debe quedar al menos un administrador' });
    }
    db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    return { ok: true };
  });

  app.post('/api/scrape', async (req, reply) => {
    if (!requireProfile(req, reply)) return;
    const url = (req.body as any)?.url;
    if (typeof url !== 'string' || url.length > 2048) return reply.code(400).send({ error: 'Pega un enlace válido' });
    try {
      const userAgent = req.headers['user-agent'];
      return await scrapeProduct(
        url,
        IMAGE_DIR,
        typeof userAgent === 'string' && userAgent.length <= 512 ? userAgent : undefined,
        (imageHost, message) => req.log.warn({ imageHost, message }, 'No se pudo descargar la imagen del producto'),
      );
    } catch (error) {
      req.log.warn({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'No se pudo extraer el enlace');
      return reply.code(400).send({ error: 'No pudimos abrir ese enlace. Comprueba la dirección e inténtalo de nuevo.' });
    }
  });

  app.post('/api/images/import', async (req, reply) => {
    if (!requireProfile(req, reply)) return;
    const url = (req.body as any)?.url;
    if (typeof url !== 'string' || !url.trim() || url.length > 2048) return reply.code(400).send({ error: 'Pega la URL directa de una imagen' });
    try {
      const userAgent = req.headers['user-agent'];
      const imagePath = await importImageFromUrl(url, IMAGE_DIR, typeof userAgent === 'string' ? userAgent : undefined);
      return reply.code(201).send({ imagePath });
    } catch {
      return reply.code(400).send({ error: 'No pudimos importar esa imagen. Comprueba que el enlace directo sea público y apunte a JPEG, PNG, WebP, GIF o AVIF.' });
    }
  });

  app.post('/api/images/upload', { bodyLimit: 9 * 1024 * 1024 }, async (req, reply) => {
    if (!requireProfile(req, reply)) return;
    const body = req.body as any;
    if (typeof body?.data !== 'string' || body.data.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) {
      return reply.code(400).send({ error: 'Selecciona una imagen de hasta 6 MB' });
    }
    try {
      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.toString('base64') !== body.data) throw new Error('Invalid base64');
      const imagePath = await saveUploadedImage(bytes, IMAGE_DIR, typeof body.type === 'string' ? body.type : '');
      return reply.code(201).send({ imagePath });
    } catch {
      return reply.code(400).send({ error: 'La imagen debe ser JPEG, PNG, WebP, GIF o AVIF y no superar 6 MB.' });
    }
  });

  app.get('/api/items/mine', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    return myItems(me.id);
  });

  app.get('/api/categories', async (req, reply) => {
    if (!requireProfile(req, reply)) return;
    return (db.prepare(`SELECT DISTINCT l.name FROM labels l JOIN item_labels il ON il.label_name = l.name
      ORDER BY l.name COLLATE NOCASE`).all() as Array<{ name: string }>).map(row => row.name);
  });

  app.get('/api/labels', async (req, reply) => {
    if (!requireProfile(req, reply)) return;
    return db.prepare('SELECT name, color FROM labels ORDER BY name COLLATE NOCASE').all();
  });

  app.get('/api/ideas/mine', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    return myIdeas(me.id);
  });

  app.get('/api/profiles/:profileId/ideas', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const recipientId = positiveId((req.params as any).profileId);
    if (recipientId === null) return reply.code(400).send({ error: 'Perfil no válido' });
    if (recipientId === me.id || !db.prepare('SELECT id FROM profiles WHERE id = ?').get(recipientId)
      || !profilesShareFamily(me.id, recipientId)) return reply.code(404).send({ error: 'Ideas no encontradas' });
    return ideasForRecipient(me.id, recipientId);
  });

  app.post('/api/profiles/:profileId/ideas', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const recipientId = positiveId((req.params as any).profileId);
    if (recipientId === null) return reply.code(400).send({ error: 'Perfil no válido' });
    if (recipientId === me.id || !profilesShareFamily(me.id, recipientId)) return reply.code(404).send({ error: 'Perfil no encontrado' });
    const recipient = db.prepare('SELECT id, name FROM profiles WHERE id = ?').get(recipientId) as { id: number; name: string } | undefined;
    if (!recipient) return reply.code(404).send({ error: 'Perfil no encontrado' });
    const { errors, fields } = giftIdeaFields((req.body ?? {}) as GiftIdeaInput);
    if (errors.length) return reply.code(400).send({ error: errors[0] });
    const insertIdea = db.transaction(() => {
      const result = db.prepare(`INSERT INTO gift_ideas
        (owner_profile_id, recipient_profile_id, recipient_name, title, url, image_path, price, currency, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        me.id, recipient.id, recipient.name, fields.title, fields.url, fields.imagePath,
        fields.price, fields.currency, fields.notes,
      );
      const id = Number(result.lastInsertRowid);
      replaceIdeaLabels(id, fields.labels);
      return id;
    });
    const id = insertIdea();
    return reply.code(201).send(ideasForRecipient(me.id, recipient.id).find(idea => idea.id === id));
  });

  app.put('/api/ideas/:ideaId', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const ideaId = positiveId((req.params as any).ideaId);
    if (ideaId === null) return reply.code(400).send({ error: 'Idea no válida' });
    const existing = db.prepare('SELECT * FROM gift_ideas WHERE id = ? AND owner_profile_id = ?').get(ideaId, me.id) as any;
    if (!existing) return reply.code(404).send({ error: 'No encontramos esa idea' });
    const input = (req.body ?? {}) as GiftIdeaInput;
    const { errors, fields } = giftIdeaFields({
      title: input.title === undefined ? existing.title : input.title,
      url: input.url === undefined ? existing.url : input.url,
      imagePath: input.imagePath === undefined ? existing.image_path : input.imagePath,
      price: input.price === undefined ? existing.price : input.price,
      currency: input.currency === undefined ? existing.currency : input.currency,
      notes: input.notes === undefined ? existing.notes : input.notes,
      labels: input.labels === undefined ? labelsForIdea(ideaId).map(label => label.name) : input.labels,
    });
    if (errors.length) return reply.code(400).send({ error: errors[0] });
    const updateIdea = db.transaction(() => {
      db.prepare(`UPDATE gift_ideas SET title = ?, url = ?, image_path = ?, price = ?, currency = ?, notes = ?
        WHERE id = ? AND owner_profile_id = ?`).run(
        fields.title, fields.url, fields.imagePath, fields.price, fields.currency, fields.notes, ideaId, me.id,
      );
      if (input.labels !== undefined) replaceIdeaLabels(ideaId, fields.labels);
    });
    updateIdea();
    return myIdeas(me.id).find(idea => idea.id === ideaId);
  });

  app.delete('/api/ideas/:ideaId', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const ideaId = positiveId((req.params as any).ideaId);
    if (ideaId === null) return reply.code(400).send({ error: 'Idea no válida' });
    const removed = db.prepare('DELETE FROM gift_ideas WHERE id = ? AND owner_profile_id = ?').run(ideaId, me.id);
    if (!removed.changes) return reply.code(404).send({ error: 'No encontramos esa idea' });
    return { ok: true };
  });

  app.get('/api/profiles/:profileId/items', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const profileId = positiveId((req.params as any).profileId);
    if (profileId === null) return reply.code(400).send({ error: 'Perfil no válido' });
    if (!db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId)) return reply.code(404).send({ error: 'Perfil no encontrado' });
    if (me.id !== profileId && !profilesShareFamily(me.id, profileId)) return reply.code(404).send({ error: 'Lista no encontrada' });
    // Same-profile reads take the owner-only query path, with no claims access.
    return me.id === profileId ? myItems(profileId) : viewedItems(profileId);
  });

  app.post('/api/items', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const { errors, fields } = itemFields((req.body ?? {}) as ItemInput);
    if (errors.length) return reply.code(400).send({ error: errors[0] });
    const f = fields as Required<typeof fields>;
    const create = db.transaction(() => {
      const result = db.prepare(`INSERT INTO items (profile_id, title, url, image_path, price, currency, rating, notes, category)
        VALUES (@profileId, @title, @url, @imagePath, @price, @currency, @rating, @notes, @category)`).run({
        profileId: me.id, title: f.title, url: f.url, imagePath: f.imagePath, price: f.price,
        currency: f.currency, rating: f.rating, notes: f.notes, category: f.category,
      });
      replaceItemLabels(Number(result.lastInsertRowid), f.labels ?? []);
      return Number(result.lastInsertRowid);
    });
    const id = create();
    return reply.code(201).send(myItems(me.id).find((item: any) => item.id === id));
  });

  app.put('/api/items/:itemId', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const id = positiveId((req.params as any).itemId);
    if (id === null) return reply.code(400).send({ error: 'Deseo no válido' });
    const existing = db.prepare('SELECT * FROM items WHERE id = ? AND profile_id = ? AND deleted_at IS NULL').get(id, me.id) as any;
    if (!existing) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    const input = (req.body ?? {}) as ItemInput;
    const { errors, fields } = itemFields(input, true);
    if (errors.length) return reply.code(400).send({ error: errors[0] });
    const value = (key: keyof ItemInput, old: string | number | null) => {
      if (input[key] === undefined || (key === 'title' && !fields.title)) return old;
      return (fields as any)[({ imagePath: 'imagePath' } as any)[key] ?? key];
    };
    const update = db.transaction(() => {
      db.prepare(`UPDATE items SET title = ?, url = ?, image_path = ?, price = ?, currency = ?, rating = ?, notes = ?, category = ? WHERE id = ? AND profile_id = ?`)
        .run(value('title', existing.title), value('url', existing.url), value('imagePath', existing.image_path),
          value('price', existing.price), value('currency', existing.currency), value('rating', existing.rating),
          value('notes', existing.notes), fields.labels === null ? existing.category : fields.category, id, me.id);
      if (fields.labels !== null) replaceItemLabels(id, fields.labels);
    });
    update();
    return myItems(me.id).find((item: any) => item.id === id);
  });

  app.delete('/api/items/:itemId', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const id = positiveId((req.params as any).itemId);
    if (id === null) return reply.code(400).send({ error: 'Deseo no válido' });
    const existing = db.prepare(`SELECT i.title, i.deleted_at, EXISTS(
      SELECT 1 FROM item_purchases purchase WHERE purchase.item_id = i.id
    ) AS purchased FROM items i WHERE i.id = ? AND i.profile_id = ?`).get(id, me.id) as { title: string; deleted_at: string | null; purchased: number } | undefined;
    if (!existing) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    if (existing.deleted_at) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    const remove = db.transaction(() => {
      notifyBuyerBeforeItemDelete(id, existing.title, me.id, me.name);
      if (existing.purchased) {
        return db.prepare('UPDATE items SET deleted_at = CURRENT_TIMESTAMP, deleted_by_owner_name = ? WHERE id = ? AND profile_id = ? AND deleted_at IS NULL')
          .run(me.name, id, me.id).changes;
      }
      return db.prepare('DELETE FROM items WHERE id = ? AND profile_id = ?').run(id, me.id).changes;
    });
    if (!remove()) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    return { ok: true };
  });

  app.post('/api/items/:itemId/alternatives', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const itemId = positiveId((req.params as any).itemId);
    if (itemId === null) return reply.code(400).send({ error: 'Deseo no válido' });
    if (!db.prepare('SELECT id FROM items WHERE id = ? AND profile_id = ? AND deleted_at IS NULL').get(itemId, me.id)) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    const body = (req.body ?? {}) as any;
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : null;
    const url = typeof body.url === 'string' ? body.url.trim().slice(0, 2048) : null;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;
    const price = parsePriceInput(body.price);
    if (!url && !title) return reply.code(400).send({ error: 'Añade un enlace o un título' });
    if (url) { try { if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error(); } catch { return reply.code(400).send({ error: 'El enlace debe empezar por http o https' }); } }
    if (price !== null && (!Number.isFinite(price) || price < 0)) return reply.code(400).send({ error: 'El precio no es válido' });
    const imagePath = typeof body.imagePath === 'string' ? body.imagePath.trim().slice(0, 500) : null;
    const result = db.prepare('INSERT INTO alternatives (item_id, url, title, price, image_path, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(itemId, url || null, title || null, price, imagePath || null, note || null);
    return reply.code(201).send(db.prepare('SELECT id, url, title, price, image_path as imagePath, note FROM alternatives WHERE id = ?').get(result.lastInsertRowid));
  });

  app.put('/api/alternatives/:alternativeId', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const id = positiveId((req.params as any).alternativeId);
    if (id === null) return reply.code(400).send({ error: 'Alternativa no válida' });
    const existing = db.prepare(`SELECT a.* FROM alternatives a JOIN items i ON i.id = a.item_id
      WHERE a.id = ? AND i.profile_id = ? AND i.deleted_at IS NULL`).get(id, me.id) as any;
    if (!existing) return reply.code(404).send({ error: 'No encontramos esa alternativa' });
    const body = (req.body ?? {}) as any;
    const title = body.title === undefined ? existing.title : typeof body.title === 'string' ? body.title.trim().slice(0, 200) || null : null;
    const url = body.url === undefined ? existing.url : typeof body.url === 'string' ? body.url.trim().slice(0, 2048) || null : null;
    const note = body.note === undefined ? existing.note : typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
    const price = body.price === undefined ? existing.price : parsePriceInput(body.price);
    const imagePath = body.imagePath === undefined ? existing.image_path : typeof body.imagePath === 'string' ? body.imagePath.trim().slice(0, 500) || null : null;
    if (!url && !title) return reply.code(400).send({ error: 'Añade un enlace o un título' });
    if (url) { try { if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error(); } catch { return reply.code(400).send({ error: 'El enlace debe empezar por http o https' }); } }
    if (price !== null && (!Number.isFinite(price) || price < 0)) return reply.code(400).send({ error: 'El precio no es válido' });
    db.prepare('UPDATE alternatives SET url = ?, title = ?, price = ?, image_path = ?, note = ? WHERE id = ?').run(url, title, price, imagePath, note, id);
    return db.prepare('SELECT id, url, title, price, image_path as imagePath, note FROM alternatives WHERE id = ?').get(id);
  });

  app.delete('/api/alternatives/:alternativeId', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const id = positiveId((req.params as any).alternativeId);
    if (id === null) return reply.code(400).send({ error: 'Alternativa no válida' });
    const result = db.prepare(`DELETE FROM alternatives WHERE id = ? AND item_id IN
      (SELECT id FROM items WHERE profile_id = ? AND deleted_at IS NULL)`).run(id, me.id);
    if (!result.changes) return reply.code(404).send({ error: 'No encontramos esa alternativa' });
    return { ok: true };
  });

  app.post('/api/items/:itemId/claim', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const itemId = positiveId((req.params as any).itemId);
    if (itemId === null) return reply.code(400).send({ error: 'Deseo no válido' });
    const owner = db.prepare('SELECT profile_id, deleted_at FROM items WHERE id = ?').get(itemId) as { profile_id: number; deleted_at: string | null } | undefined;
    if (!owner) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    if (owner.deleted_at) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    if (owner.profile_id === me.id) return reply.code(403).send({ error: 'No puedes reservar tu propio deseo' });
    if (!profilesShareFamily(me.id, owner.profile_id)) return reply.code(404).send({ error: 'Deseo no encontrado' });
    if (db.prepare('SELECT 1 FROM item_purchases WHERE item_id = ?').get(itemId)) return reply.code(409).send({ error: 'Este regalo ya está comprado' });
    try {
      db.prepare('INSERT INTO claims (item_id, profile_id) VALUES (?, ?)').run(itemId, me.id);
      return reply.code(201).send({ ok: true });
    } catch (error) {
      if (isConstraintError(error)) return reply.code(409).send({ error: 'Otra persona ya lo ha reservado' });
      throw error;
    }
  });

  app.delete('/api/items/:itemId/claim', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const itemId = positiveId((req.params as any).itemId);
    if (itemId === null) return reply.code(400).send({ error: 'Deseo no válido' });
    const owner = db.prepare('SELECT profile_id FROM items WHERE id = ?').get(itemId) as { profile_id: number } | undefined;
    if (!owner) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    if (owner.profile_id === me.id) return reply.code(403).send({ error: 'No puedes cambiar la reserva de tu propio deseo' });
    if (!profilesShareFamily(me.id, owner.profile_id)) return reply.code(404).send({ error: 'Deseo no encontrado' });
    if (db.prepare('SELECT 1 FROM item_purchases WHERE item_id = ?').get(itemId)) return reply.code(409).send({ error: 'No puedes quitar la reserva de un regalo comprado. Revierte la compra desde Ajustes.' });
    const result = db.prepare('DELETE FROM claims WHERE item_id = ? AND profile_id = ?').run(itemId, me.id);
    if (!result.changes) return reply.code(404).send({ error: 'No tienes una reserva para este deseo' });
    return { ok: true };
  });

  app.post('/api/items/:itemId/purchase', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const itemId = positiveId((req.params as any).itemId);
    if (itemId === null) return reply.code(400).send({ error: 'Deseo no válido' });
    const item = db.prepare('SELECT profile_id, deleted_at FROM items WHERE id = ?').get(itemId) as { profile_id: number; deleted_at: string | null } | undefined;
    if (!item || item.deleted_at) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    if (item.profile_id === me.id) return reply.code(403).send({ error: 'No puedes comprar tu propio deseo' });
    if (!profilesShareFamily(me.id, item.profile_id)) return reply.code(404).send({ error: 'Deseo no encontrado' });
    if (!db.prepare('SELECT 1 FROM claims WHERE item_id = ? AND profile_id = ?').get(itemId, me.id)) {
      return reply.code(409).send({ error: 'Primero tienes que reservar este regalo' });
    }
    try {
      db.prepare(`INSERT INTO item_purchases (item_id, buyer_profile_id, buyer_name, buyer_avatar)
        VALUES (?, ?, ?, ?)`).run(itemId, me.id, me.name, me.avatar);
      return reply.code(201).send({ ok: true });
    } catch (error) {
      if (isConstraintError(error)) return reply.code(409).send({ error: 'Este regalo ya está comprado' });
      throw error;
    }
  });

  app.delete('/api/purchases/:itemId', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const itemId = positiveId((req.params as any).itemId);
    if (itemId === null) return reply.code(400).send({ error: 'Compra no válida' });
    const purchase = db.prepare(`SELECT i.deleted_at FROM item_purchases purchase
      JOIN items i ON i.id = purchase.item_id
      WHERE purchase.item_id = ? AND purchase.buyer_profile_id = ?`).get(itemId, me.id) as { deleted_at: string | null } | undefined;
    if (!purchase) return reply.code(404).send({ error: 'No encontramos esa compra' });
    const revert = db.transaction(() => {
      if (purchase.deleted_at) {
        db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
      } else {
        db.prepare('DELETE FROM item_purchases WHERE item_id = ? AND buyer_profile_id = ?').run(itemId, me.id);
        db.prepare('DELETE FROM claims WHERE item_id = ? AND profile_id = ?').run(itemId, me.id);
      }
    });
    revert();
    return { ok: true };
  });

  // --- Frontend compilado (producción) y producto descargado ---
  const bundledWebDir = path.resolve('dist/web');
  const webDir = path.resolve(process.env.WEB_DIR ?? bundledWebDir);
  if (process.env.WEB_DIR) {
    mkdirSync(webDir, { recursive: true });
    if (!existsSync(path.join(webDir, 'index.html'))) {
      cpSync(bundledWebDir, webDir, { recursive: true });
    }
  }
  if (existsSync(webDir)) await app.register(fstatic, { root: webDir });
  await app.register(fstatic, { root: IMAGE_DIR, prefix: '/images/', decorateReply: false });
  if (existsSync(webDir)) app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api') ? reply.code(404).send({ error: 'No encontrado' }) : reply.sendFile('index.html'));
  return app;
}

const startSession = (reply: FastifyReply, profileId: number) => {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, profile_id) VALUES (?, ?)').run(token, profileId);
  reply.setCookie('sid', token, { httpOnly: true, sameSite: 'lax', path: BASE_PATH || '/', maxAge: 60 * 60 * 24 * 30 });
};

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp();
    const port = Number(process.env.PORT ?? 3000);
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info({ port, schemaRevision: TARGET_SCHEMA_REVISION }, 'GiftApp is ready');
  } catch (error) {
    app?.log.fatal({ err: error, schemaRevision: TARGET_SCHEMA_REVISION }, 'GiftApp failed to start');
    if (app) await app.close();
    db.close();
    process.exitCode = 1;
  }
}
