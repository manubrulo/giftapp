import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { importImageFromUrl, scrapeProduct } from './scrape.js';

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
    // Product URLs often end in an opaque ID. The host is still a useful,
    // editable label and lets a link with only a thumbnail be saved.
    return (slug && !/^[a-z0-9]{6,}$/i.test(slug) ? slug : parsed.hostname).slice(0, 200);
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

type ItemInput = {
  title?: unknown; url?: unknown; imagePath?: unknown; price?: unknown; currency?: unknown;
  rating?: unknown; notes?: unknown; category?: unknown;
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
  const category = text(input.category, 60, 'La categoría');
  const currency = (text(input.currency, 3, 'La moneda') ?? 'EUR').toUpperCase();
  const price = input.price === undefined && partial ? null : input.price === '' || input.price == null ? null : Number(input.price);
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 1_000_000_000)) errors.push('El precio no es válido');
  const rating = input.rating === undefined && partial ? null : input.rating == null || input.rating === '' ? 3 : Number(input.rating);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) errors.push('La valoración debe estar entre 1 y 5');
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('La moneda debe tener 3 letras');
  if (url) { try { if (!['http:', 'https:'].includes(new URL(url).protocol)) errors.push('El enlace debe empezar por http o https'); } catch { errors.push('El enlace no es válido'); } }
  if (!partial && !title) title = fallbackItemTitle(url);
  if (!partial && !title) errors.push('Añade un enlace o un nombre');
  if (imagePath && !imagePath.startsWith('/images/')) errors.push('La imagen no es válida');
  return { errors, fields: { title, url, imagePath, price, currency, rating, notes, category } };
};

const publicItem = (row: any) => ({
  id: row.id, profileId: row.profile_id, title: row.title, url: row.url,
  imagePath: row.image_path, price: row.price, currency: row.currency,
  rating: row.rating, notes: row.notes, category: row.category, createdAt: row.created_at,
  alternatives: row.alternatives ?? [],
  ...(Object.hasOwn(row, 'claim_profile_id') ? {
    reservedBy: row.claim_profile_id ? { id: row.claim_profile_id, name: row.claim_profile_name, avatar: row.claim_profile_avatar } : null,
  } : {}),
});
const alternativesFor = (itemId: number) => db.prepare('SELECT id, url, title, price, image_path as imagePath, note FROM alternatives WHERE item_id = ? ORDER BY id').all(itemId);
const notifyBuyerBeforeItemDelete = (itemId: number, itemTitle: string, ownerId: number, ownerName: string) => {
  const claim = db.prepare('SELECT profile_id FROM claims WHERE item_id = ?').get(itemId) as { profile_id: number } | undefined;
  if (claim && claim.profile_id !== ownerId) {
    db.prepare('INSERT INTO notifications (profile_id, item_title, deleted_by) VALUES (?, ?, ?)').run(claim.profile_id, itemTitle, ownerName);
  }
};
const myItems = (profileId: number) => {
  // PRIVACY: this owner-only query deliberately never reads the claims table.
  const rows = db.prepare('SELECT * FROM items WHERE profile_id = ? ORDER BY created_at DESC, id DESC').all(profileId) as any[];
  return rows.map(row => publicItem({ ...row, alternatives: alternativesFor(row.id) }));
};
const viewedItems = (profileId: number) => {
  const rows = db.prepare(`SELECT i.*, c.profile_id AS claim_profile_id,
      buyer.name AS claim_profile_name, buyer.avatar AS claim_profile_avatar
    FROM items i LEFT JOIN claims c ON c.item_id = i.id
    LEFT JOIN profiles buyer ON buyer.id = c.profile_id
    WHERE i.profile_id = ? ORDER BY i.created_at DESC, i.id DESC`).all(profileId) as any[];
  return rows.map(row => publicItem({ ...row, alternatives: alternativesFor(row.id) }));
};

function isConstraintError(error: unknown) {
  return error instanceof Error && /constraint/i.test(error.message);
}

export async function buildApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    bodyLimit: 2 * 1024 * 1024,
    rewriteUrl: request => {
      const url = request.url ?? '/';
      return BASE_PATH && (url === BASE_PATH || url.startsWith(`${BASE_PATH}/`))
        ? url.slice(BASE_PATH.length) || '/'
        : url;
    },
  });
  await app.register(cookie);

  app.get('/api/profiles', async () =>
    (db.prepare('SELECT * FROM profiles ORDER BY name').all() as Profile[]).map(publicProfile));

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
    const items = db.prepare('SELECT id, title FROM items WHERE profile_id = ?').all(me.id) as Array<{ id: number; title: string }>;
    const remove = db.transaction(() => {
      for (const item of items) notifyBuyerBeforeItemDelete(item.id, item.title, me.id, me.name);
      return db.prepare('DELETE FROM items WHERE profile_id = ?').run(me.id).changes;
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
    const owned = Number((db.prepare(`SELECT COUNT(*) AS count FROM items WHERE profile_id = ? AND id IN (${placeholders})`).get(me.id, ...itemIds) as any).count);
    if (owned !== itemIds.length) return reply.code(404).send({ error: 'Uno o más deseos ya no están disponibles en tu lista' });
    const selectedItems = db.prepare(`SELECT id, title FROM items WHERE profile_id = ? AND id IN (${placeholders})`).all(me.id, ...itemIds) as Array<{ id: number; title: string }>;
    const remove = db.transaction(() => {
      for (const item of selectedItems) notifyBuyerBeforeItemDelete(item.id, item.title, me.id, me.name);
      return db.prepare(`DELETE FROM items WHERE profile_id = ? AND id IN (${placeholders})`).run(me.id, ...itemIds).changes;
    });
    return { ok: true, deleted: remove() };
  });

  app.get('/api/admin/profiles', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return db.prepare(`SELECT p.id, p.name, p.avatar, p.role, p.pin_hash IS NOT NULL AS hasPin, p.created_at AS createdAt,
      (SELECT COUNT(*) FROM items i WHERE i.profile_id = p.id) AS itemCount
      FROM profiles p ORDER BY p.created_at, p.id`).all();
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
      return { ...publicProfile(profile), itemCount: Number((db.prepare('SELECT COUNT(*) AS n FROM items WHERE profile_id = ?').get(id) as any).n) };
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
      req.log.warn({ err: error }, 'No se pudo extraer el enlace');
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

  app.get('/api/items/mine', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    return myItems(me.id);
  });

  app.get('/api/profiles/:profileId/items', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const profileId = positiveId((req.params as any).profileId);
    if (profileId === null) return reply.code(400).send({ error: 'Perfil no válido' });
    if (!db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId)) return reply.code(404).send({ error: 'Perfil no encontrado' });
    // Same-profile reads take the owner-only query path, with no claims access.
    return me.id === profileId ? myItems(profileId) : viewedItems(profileId);
  });

  app.post('/api/items', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const { errors, fields } = itemFields((req.body ?? {}) as ItemInput);
    if (errors.length) return reply.code(400).send({ error: errors[0] });
    const f = fields as Required<typeof fields>;
    const result = db.prepare(`INSERT INTO items (profile_id, title, url, image_path, price, currency, rating, notes, category)
      VALUES (@profileId, @title, @url, @imagePath, @price, @currency, @rating, @notes, @category)`).run({
      profileId: me.id, title: f.title, url: f.url, imagePath: f.imagePath, price: f.price,
      currency: f.currency, rating: f.rating, notes: f.notes, category: f.category,
    });
    return reply.code(201).send(myItems(me.id).find((item: any) => item.id === Number(result.lastInsertRowid)));
  });

  app.put('/api/items/:itemId', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const id = positiveId((req.params as any).itemId);
    if (id === null) return reply.code(400).send({ error: 'Deseo no válido' });
    const existing = db.prepare('SELECT * FROM items WHERE id = ? AND profile_id = ?').get(id, me.id) as any;
    if (!existing) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    const input = (req.body ?? {}) as ItemInput;
    const { errors, fields } = itemFields(input, true);
    if (errors.length) return reply.code(400).send({ error: errors[0] });
    const value = (key: keyof ItemInput, old: string | number | null) => {
      if (input[key] === undefined || (key === 'title' && !fields.title)) return old;
      return (fields as any)[({ imagePath: 'imagePath' } as any)[key] ?? key];
    };
    db.prepare(`UPDATE items SET title = ?, url = ?, image_path = ?, price = ?, currency = ?, rating = ?, notes = ?, category = ? WHERE id = ? AND profile_id = ?`)
      .run(value('title', existing.title), value('url', existing.url), value('imagePath', existing.image_path),
        value('price', existing.price), value('currency', existing.currency), value('rating', existing.rating),
        value('notes', existing.notes), value('category', existing.category), id, me.id);
    return myItems(me.id).find((item: any) => item.id === id);
  });

  app.delete('/api/items/:itemId', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const id = positiveId((req.params as any).itemId);
    if (id === null) return reply.code(400).send({ error: 'Deseo no válido' });
    const existing = db.prepare('SELECT title FROM items WHERE id = ? AND profile_id = ?').get(id, me.id) as { title: string } | undefined;
    if (!existing) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    const remove = db.transaction(() => {
      notifyBuyerBeforeItemDelete(id, existing.title, me.id, me.name);
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
    if (!db.prepare('SELECT id FROM items WHERE id = ? AND profile_id = ?').get(itemId, me.id)) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    const body = (req.body ?? {}) as any;
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : null;
    const url = typeof body.url === 'string' ? body.url.trim().slice(0, 2048) : null;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;
    const price = body.price == null || body.price === '' ? null : Number(body.price);
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
      WHERE a.id = ? AND i.profile_id = ?`).get(id, me.id) as any;
    if (!existing) return reply.code(404).send({ error: 'No encontramos esa alternativa' });
    const body = (req.body ?? {}) as any;
    const title = body.title === undefined ? existing.title : typeof body.title === 'string' ? body.title.trim().slice(0, 200) || null : null;
    const url = body.url === undefined ? existing.url : typeof body.url === 'string' ? body.url.trim().slice(0, 2048) || null : null;
    const note = body.note === undefined ? existing.note : typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
    const price = body.price === undefined ? existing.price : body.price == null || body.price === '' ? null : Number(body.price);
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
      (SELECT id FROM items WHERE profile_id = ?)`).run(id, me.id);
    if (!result.changes) return reply.code(404).send({ error: 'No encontramos esa alternativa' });
    return { ok: true };
  });

  app.post('/api/items/:itemId/claim', async (req, reply) => {
    const me = requireProfile(req, reply);
    if (!me) return;
    const itemId = positiveId((req.params as any).itemId);
    if (itemId === null) return reply.code(400).send({ error: 'Deseo no válido' });
    const owner = db.prepare('SELECT profile_id FROM items WHERE id = ?').get(itemId) as { profile_id: number } | undefined;
    if (!owner) return reply.code(404).send({ error: 'No encontramos ese deseo' });
    if (owner.profile_id === me.id) return reply.code(403).send({ error: 'No puedes reservar tu propio deseo' });
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
    const result = db.prepare('DELETE FROM claims WHERE item_id = ? AND profile_id = ?').run(itemId, me.id);
    if (!result.changes) return reply.code(404).send({ error: 'No tienes una reserva para este deseo' });
    return { ok: true };
  });

  // --- Frontend compilado (producción) y producto descargado ---
  const webDir = path.resolve(process.env.WEB_DIR ?? 'dist/web');
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
  const app = await buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
}
