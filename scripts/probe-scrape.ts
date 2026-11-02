import Database from 'better-sqlite3';
import path from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const addWishes = args.includes('--add');
const cleanupProbes = args.includes('--cleanup');
const urls = args.filter(value => !value.startsWith('--'));
if ((!urls.length && !cleanupProbes) || urls.length > 30 || (cleanupProbes && urls.length > 0)) {
  console.error('Uso: pnpm probe:scrape [--add] <url> [url…] | pnpm probe:scrape --cleanup (máximo 30 enlaces)');
  process.exit(2);
}

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const db = new Database(path.join(dataDir, 'regalos.db'), { readonly: true });
const session = db.prepare('SELECT token FROM sessions ORDER BY created_at DESC LIMIT 1').get() as { token: string } | undefined;
db.close();
if (!session) {
  console.error('No hay una sesión activa en la base de datos de GiftApp. Inicia sesión primero.');
  process.exit(2);
}

const baseUrl = (process.env.API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const me = await fetch(`${baseUrl}/api/me`, { headers: { cookie: `sid=${encodeURIComponent(session.token)}` } });
if (!me.ok || !(await me.json() as any).me) {
  console.error(`GiftApp no aceptó la sesión (${me.status}). Comprueba API_BASE_URL y vuelve a iniciar sesión.`);
  process.exit(2);
}
const wishlistResponse = await fetch(`${baseUrl}/api/items/mine`, { headers: { cookie: `sid=${encodeURIComponent(session.token)}` } });
const existingItems = wishlistResponse.ok ? await wishlistResponse.json() as any[] : [];
if (cleanupProbes) {
  const removed = [];
  for (const item of existingItems.filter(item => item.category === 'Prueba de extracción')) {
    const response = await fetch(`${baseUrl}/api/items/${item.id}`, {
      method: 'DELETE', headers: { cookie: `sid=${encodeURIComponent(session.token)}` },
    });
    removed.push({ id: item.id, title: item.title, status: response.status });
  }
  console.log(JSON.stringify({ removed }, null, 2));
  process.exit(0);
}

const results = [];
for (const url of urls) {
  try {
    const response = await fetch(`${baseUrl}/api/scrape`, {
      method: 'POST',
      headers: { cookie: `sid=${encodeURIComponent(session.token)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const body = await response.json().catch(() => ({ error: 'La API no devolvió JSON' }));
    const imagePath = typeof body?.imagePath === 'string' ? body.imagePath : null;
    const imageFilename = imagePath?.match(/^\/images\/([a-f0-9]{32}\.[a-z0-9]+)$/i)?.[1];
    const result: any = {
      inputUrl: url,
      status: response.status,
      ok: response.ok,
      imageDownloaded: imageFilename ? existsSync(path.join(dataDir, 'images', imageFilename)) : false,
      preview: body,
    };
    let redirectedToListing = false;
    try {
      const target = new URL(body?.url ?? url);
      redirectedToListing = target.hostname === new URL(url).hostname
        && target.pathname !== new URL(url).pathname
        && /\/(?:cat|categories|search|catalog)(?:\/|$)/i.test(target.pathname);
    } catch { /* The API response may not include a URL. */ }
    if (addWishes && redirectedToListing) result.saveSkipped = 'La tienda redirigió a una categoría o búsqueda, no a la ficha del producto.';
    if (addWishes && response.ok && !redirectedToListing && (body?.imagePath || body?.url)) {
      const existing = existingItems.find(item => item.url === (body.url ?? url));
      const itemInput: Record<string, unknown> = { title: body.title || '' };
      if (body.imagePath) itemInput.imagePath = body.imagePath;
      if (body.price != null) itemInput.price = body.price;
      if (body.currency) itemInput.currency = body.currency;
      if (!existing) {
        itemInput.url = body.url ?? url;
        itemInput.rating = 3;
        itemInput.category = 'Prueba de extracción';
      }
      const save = await fetch(`${baseUrl}${existing ? `/api/items/${existing.id}` : '/api/items'}`, {
        method: existing ? 'PUT' : 'POST',
        headers: { cookie: `sid=${encodeURIComponent(session.token)}`, 'content-type': 'application/json' },
        body: JSON.stringify(itemInput),
      });
      result.savedItem = {
        action: existing ? 'updated-existing' : 'created',
        status: save.status,
        item: await save.json().catch(() => ({ error: 'La API no devolvió JSON' })),
      };
      if (!existing && save.ok) existingItems.push(result.savedItem.item);
    }
    results.push(result);
  } catch (error) {
    results.push({ inputUrl: url, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
console.log(JSON.stringify(results, null, 2));
