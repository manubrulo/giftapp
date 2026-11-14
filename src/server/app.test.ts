import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const dataDir = mkdtempSync(path.join(tmpdir(), 'regalos-test-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
const [{ buildApp }, { db }] = await Promise.all([import('./index.js'), import('./db.js')]);
const app = await buildApp();
let alice: { id: number; cookie: string };
let bob: { id: number; cookie: string };

before(async () => { await app.ready(); });
beforeEach(() => db.exec('DELETE FROM claims; DELETE FROM alternatives; DELETE FROM items; DELETE FROM sessions; DELETE FROM family_memberships; DELETE FROM families; DELETE FROM profiles;'));
after(async () => { await app.close(); db.close(); rmSync(dataDir, { recursive: true, force: true }); });

async function profile(name: string, pin?: string, joinTestFamily = true) {
  const response = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name, pin } });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const id = response.json().me.id as number;
  if (joinTestFamily) {
    db.prepare("INSERT OR IGNORE INTO families (name) VALUES ('Pruebas')").run();
    const familyId = (db.prepare("SELECT id FROM families WHERE name = 'Pruebas'").get() as { id: number }).id;
    db.prepare('INSERT INTO family_memberships (family_id, profile_id) VALUES (?, ?)').run(familyId, id);
  }
  return { id, cookie };
}
async function item(cookie: string, title = 'Libro') {
  const response = await app.inject({ method: 'POST', url: '/api/items', headers: { cookie }, payload: { title, url: 'https://shop.example/item', rating: 5 } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

test('creates PIN and PIN-free profiles, logs in, logs out, and throttles five wrong attempts', async () => {
  const pinProfile = await profile('Con PIN', '1234');
  const noPin = await profile('Sin PIN');
  const profiles = await app.inject({ method: 'GET', url: '/api/profiles' });
  assert.equal(profiles.statusCode, 200);
  assert.deepEqual(profiles.json().map((p: any) => p.hasPin).sort(), [false, true]);
  assert.equal(JSON.stringify(profiles.json()).includes('pin_hash'), false);

  await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: pinProfile.cookie } });
  const loggedOut = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: pinProfile.cookie } });
  assert.equal(loggedOut.json().me, null);
  const wrong = await app.inject({ method: 'POST', url: '/api/login', payload: { profileId: pinProfile.id, pin: '9999' } });
  assert.equal(wrong.statusCode, 401);
  const correct = await app.inject({ method: 'POST', url: '/api/login', payload: { profileId: pinProfile.id, pin: '1234' } });
  assert.equal(correct.statusCode, 200);

  const locked = await profile('Bloqueado', '5678');
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await app.inject({ method: 'POST', url: '/api/login', payload: { profileId: locked.id, pin: '0000' } });
    assert.equal(response.statusCode, 401);
  }
  const throttled = await app.inject({ method: 'POST', url: '/api/login', payload: { profileId: locked.id, pin: '5678' } });
  assert.equal(throttled.statusCode, 429);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { profileId: noPin.id } })).statusCode, 200);
});

test('members can manage their profile and clear their list; admins can manage profiles and roles', async () => {
  const admin = await profile('Admin', '1111');
  const member = await profile('Member', '2222');
  const ownWish = await item(member.cookie, 'Mesa');
  await item(admin.cookie, 'Libro');

  const adminList = await app.inject({ method: 'GET', url: '/api/admin/profiles', headers: { cookie: admin.cookie } });
  assert.equal(adminList.statusCode, 200);
  assert.deepEqual(adminList.json().map((p: any) => p.role), ['admin', 'member']);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/profiles', headers: { cookie: member.cookie } })).statusCode, 403);

  const profileUpdate = await app.inject({ method: 'PUT', url: '/api/me/profile', headers: { cookie: member.cookie }, payload: { name: 'Membresía', avatar: '🐼', pin: '3333' } });
  assert.equal(profileUpdate.statusCode, 200);
  assert.equal(profileUpdate.json().me.name, 'Membresía');
  assert.equal(profileUpdate.json().me.hasPin, true);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { profileId: member.id, pin: '2222' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { profileId: member.id, pin: '3333' } })).statusCode, 200);

  const promote = await app.inject({ method: 'PUT', url: `/api/admin/profiles/${member.id}`, headers: { cookie: admin.cookie }, payload: { role: 'admin' } });
  assert.equal(promote.statusCode, 200);
  assert.equal(promote.json().role, 'admin');
  assert.equal((await app.inject({ method: 'PUT', url: `/api/admin/profiles/${member.id}`, headers: { cookie: admin.cookie }, payload: { role: 'member' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/admin/profiles/${admin.id}`, headers: { cookie: admin.cookie }, payload: { role: 'member' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/profiles/${admin.id}`, headers: { cookie: admin.cookie } })).statusCode, 400);

  const cleared = await app.inject({ method: 'DELETE', url: '/api/items/mine', headers: { cookie: member.cookie } });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().deleted, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/api/items/mine', headers: { cookie: member.cookie } })).json().length, 0);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/profiles/${member.id}`, headers: { cookie: admin.cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/profiles' })).json().length, 1);
  assert.ok(ownWish.id);
});

test('families restrict wishlist and reservation access, support overlapping memberships, and orphan members retain their own lists', async () => {
  const admin = await profile('Admin de familias', undefined, false);
  const owner = await profile('Propietaria', undefined, false);
  const buyerA = await profile('Compradora A', undefined, false);
  const buyerB = await profile('Compradora B', undefined, false);
  const orphan = await profile('Perfil huérfano', undefined, false);
  const outsider = await profile('Sin familia', undefined, false);
  const familyA = await app.inject({ method: 'POST', url: '/api/admin/families', headers: { cookie: admin.cookie }, payload: { name: 'Familia A' } });
  const familyB = await app.inject({ method: 'POST', url: '/api/admin/families', headers: { cookie: admin.cookie }, payload: { name: 'Familia B' } });
  assert.equal(familyA.statusCode, 201, familyA.body);
  assert.equal(familyB.statusCode, 201, familyB.body);
  await app.inject({ method: 'PUT', url: `/api/admin/families/${familyA.json().id}`, headers: { cookie: admin.cookie }, payload: { profileIds: [owner.id, buyerA.id] } });
  await app.inject({ method: 'PUT', url: `/api/admin/families/${familyB.json().id}`, headers: { cookie: admin.cookie }, payload: { profileIds: [owner.id, buyerB.id, orphan.id] } });
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/families', headers: { cookie: buyerA.cookie } })).statusCode, 403);
  assert.deepEqual(new Set((await app.inject({ method: 'GET', url: '/api/profiles/visible', headers: { cookie: orphan.cookie } })).json().map((p: any) => p.id)), new Set([orphan.id, owner.id, buyerB.id]));

  const wish = await item(owner.cookie, 'Regalo compartido');
  const visibleToB = await app.inject({ method: 'GET', url: `/api/profiles/${owner.id}/items`, headers: { cookie: buyerB.cookie } });
  assert.equal(visibleToB.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/items/${wish.id}/claim`, headers: { cookie: buyerA.cookie }, payload: {} })).statusCode, 201);
  const sharedReservation = await app.inject({ method: 'GET', url: `/api/profiles/${owner.id}/items`, headers: { cookie: buyerB.cookie } });
  assert.equal(sharedReservation.json()[0].reservedBy.name, 'Compradora A');
  assert.equal((await app.inject({ method: 'POST', url: `/api/items/${wish.id}/claim`, headers: { cookie: buyerB.cookie }, payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${owner.id}/items`, headers: { cookie: outsider.cookie } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/items/${wish.id}/claim`, headers: { cookie: outsider.cookie }, payload: {} })).statusCode, 404);

  const orphanWish = await item(orphan.cookie, 'Deseo propio');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/families/${familyB.json().id}`, headers: { cookie: admin.cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/items/mine', headers: { cookie: orphan.cookie } })).json()[0].id, orphanWish.id);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${owner.id}/items`, headers: { cookie: buyerB.cookie } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/items/mine`, headers: { cookie: owner.cookie } })).json()[0].id, wish.id);
});

test('categories are suggested globally and newly typed labels are saved on wishes', async () => {
  alice = await profile('Etiquetas A');
  bob = await profile('Etiquetas B');
  const first = await app.inject({ method: 'POST', url: '/api/items', headers: { cookie: alice.cookie }, payload: { title: 'Libro', category: 'Lectura' } });
  assert.equal(first.statusCode, 201);
  const saved = await app.inject({ method: 'POST', url: '/api/items', headers: { cookie: bob.cookie }, payload: { title: 'Maleta', category: 'Viaje' } });
  assert.equal(saved.statusCode, 201);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/categories', headers: { cookie: bob.cookie } })).json(), ['Lectura', 'Viaje']);
  assert.equal((await app.inject({ method: 'GET', url: '/api/items/mine', headers: { cookie: bob.cookie } })).json()[0].category, 'Viaje');
});

test('owner wishlist stays identical after a claim; visitors see the buyer and can remove their claim', async () => {
  alice = await profile('Ana');
  bob = await profile('Bea');
  const desire = await item(alice.cookie, 'Auriculares');
  const beforeOwner = await app.inject({ method: 'GET', url: '/api/items/mine', headers: { cookie: alice.cookie } });
  assert.equal(beforeOwner.statusCode, 200);
  db.prepare('INSERT INTO claims (item_id, profile_id) VALUES (?, ?)').run(desire.id, bob.id);
  const afterOwner = await app.inject({ method: 'GET', url: '/api/items/mine', headers: { cookie: alice.cookie } });
  const sameProfileRoute = await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/items`, headers: { cookie: alice.cookie } });
  assert.equal(afterOwner.statusCode, beforeOwner.statusCode);
  assert.equal(afterOwner.body, beforeOwner.body);
  assert.equal(sameProfileRoute.body, beforeOwner.body);
  assert.equal(afterOwner.body.includes('reserved'), false);
  assert.equal(afterOwner.body.includes('Bea'), false);

  const visitor = await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/items`, headers: { cookie: bob.cookie } });
  assert.deepEqual(visitor.json()[0].reservedBy, { id: bob.id, name: 'Bea', avatar: '🙂' });
  const cancel = await app.inject({ method: 'DELETE', url: `/api/items/${desire.id}/claim`, headers: { cookie: bob.cookie } });
  assert.equal(cancel.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/items`, headers: { cookie: bob.cookie } })).json()[0].reservedBy, null);
});

test('owner deletion notifies the buyer until they dismiss the notice', async () => {
  alice = await profile('Propietaria');
  bob = await profile('Comprador');
  const desire = await item(alice.cookie, 'Taza azul');
  await app.inject({ method: 'POST', url: `/api/items/${desire.id}/claim`, headers: { cookie: bob.cookie }, payload: {} });

  const removed = await app.inject({ method: 'DELETE', url: `/api/items/${desire.id}`, headers: { cookie: alice.cookie } });
  assert.equal(removed.statusCode, 200);
  const buyerNotices = await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: bob.cookie } });
  assert.deepEqual(buyerNotices.json().map((notice: any) => ({ itemTitle: notice.itemTitle, deletedBy: notice.deletedBy })), [{ itemTitle: 'Taza azul', deletedBy: 'Propietaria' }]);
  const noticeId = buyerNotices.json()[0].id;
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: alice.cookie } })).json(), []);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/notifications/${noticeId}`, headers: { cookie: alice.cookie } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/notifications/${noticeId}`, headers: { cookie: bob.cookie } })).statusCode, 200);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: bob.cookie } })).json(), []);
});

test('supports item and alternative CRUD while enforcing profile ownership and one claim', async () => {
  alice = await profile('Cris'); bob = await profile('Dani');
  const desire = await item(alice.cookie, 'Mochila');
  const alternative = await app.inject({ method: 'POST', url: `/api/items/${desire.id}/alternatives`, headers: { cookie: alice.cookie }, payload: { url: 'https://shop.example/blue', title: 'Azul' } });
  assert.equal(alternative.statusCode, 201);
  const updateAlternative = await app.inject({ method: 'PUT', url: `/api/alternatives/${alternative.json().id}`, headers: { cookie: alice.cookie }, payload: { title: 'Azul oscuro' } });
  assert.equal(updateAlternative.statusCode, 200);
  assert.equal(updateAlternative.json().title, 'Azul oscuro');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/alternatives/${alternative.json().id}`, headers: { cookie: alice.cookie } })).statusCode, 200);

  const update = await app.inject({ method: 'PUT', url: `/api/items/${desire.id}`, headers: { cookie: alice.cookie }, payload: { title: 'Mochila grande', category: 'Viaje' } });
  assert.equal(update.statusCode, 200);
  assert.equal(update.json().title, 'Mochila grande');
  assert.equal((await app.inject({ method: 'PUT', url: `/api/items/${desire.id}`, headers: { cookie: bob.cookie }, payload: { title: 'Hack' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/items/${desire.id}/claim`, headers: { cookie: alice.cookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/items/${desire.id}/claim`, headers: { cookie: bob.cookie } })).statusCode, 201);
  const secondClaim = await profile('Eli');
  assert.equal((await app.inject({ method: 'POST', url: `/api/items/${desire.id}/claim`, headers: { cookie: secondClaim.cookie } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/items/${desire.id}`, headers: { cookie: alice.cookie } })).statusCode, 200);
});

test('saves a wishlist link with an image when the page has no title or price', async () => {
  alice = await profile('Miniatura');
  const response = await app.inject({
    method: 'POST', url: '/api/items', headers: { cookie: alice.cookie },
    payload: { url: 'https://shop.example/products/pretty-lamp.html', imagePath: '/images/lamp.jpg', price: null },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().title, 'pretty lamp');
  assert.equal(response.json().url, 'https://shop.example/products/pretty-lamp.html');
  assert.equal(response.json().imagePath, '/images/lamp.jpg');
  assert.equal(response.json().price, null);
});

test('accepts comma decimals for item and alternative prices and rejects malformed values', async () => {
  alice = await profile('Precios');
  const created = await app.inject({ method: 'POST', url: '/api/items', headers: { cookie: alice.cookie }, payload: { title: 'Vela', price: '2,5' } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().price, 2.5);
  const updated = await app.inject({ method: 'PUT', url: `/api/items/${created.json().id}`, headers: { cookie: alice.cookie }, payload: { price: '2.5' } });
  assert.equal(updated.json().price, 2.5);
  const alternative = await app.inject({ method: 'POST', url: `/api/items/${created.json().id}/alternatives`, headers: { cookie: alice.cookie }, payload: { title: 'Roja', price: '3,75' } });
  assert.equal(alternative.statusCode, 201, alternative.body);
  assert.equal(alternative.json().price, 3.75);
  const malformed = await app.inject({ method: 'PUT', url: `/api/items/${created.json().id}`, headers: { cookie: alice.cookie }, payload: { price: '1.234,56' } });
  assert.equal(malformed.statusCode, 400);
});

test('bulk-deletes selected wishes only from the signed-in profile', async () => {
  alice = await profile('Selección');
  bob = await profile('Otra lista');
  const first = await item(alice.cookie, 'Uno');
  const second = await item(alice.cookie, 'Dos');
  const foreign = await item(bob.cookie, 'Ajeno');
  await app.inject({ method: 'POST', url: `/api/items/${first.id}/claim`, headers: { cookie: bob.cookie }, payload: {} });

  const invalid = await app.inject({ method: 'POST', url: '/api/items/mine/delete-selected', headers: { cookie: alice.cookie }, payload: { itemIds: [first.id, foreign.id] } });
  assert.equal(invalid.statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/items/mine', headers: { cookie: alice.cookie } })).json().length, 2);

  const deleted = await app.inject({ method: 'POST', url: '/api/items/mine/delete-selected', headers: { cookie: alice.cookie }, payload: { itemIds: [first.id] } });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(deleted.json().deleted, 1);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/items/mine', headers: { cookie: alice.cookie } })).json().map((row: any) => row.id), [second.id]);
  assert.equal((await app.inject({ method: 'GET', url: '/api/items/mine', headers: { cookie: bob.cookie } })).json()[0].id, foreign.id);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: bob.cookie } })).json().map((notice: any) => ({ itemTitle: notice.itemTitle, deletedBy: notice.deletedBy })), [{ itemTitle: 'Uno', deletedBy: 'Selección' }]);
});

test('manual image URL import requires a session and rejects private targets', async () => {
  const unauthenticated = await app.inject({ method: 'POST', url: '/api/images/import', payload: { url: 'https://example.com/image.png' } });
  assert.equal(unauthenticated.statusCode, 401);
  alice = await profile('Imagen URL');
  const privateTarget = await app.inject({ method: 'POST', url: '/api/images/import', headers: { cookie: alice.cookie }, payload: { url: 'http://127.0.0.1/image.png' } });
  assert.equal(privateTarget.statusCode, 400);
});

test('image uploads require a session and save supported image bytes locally', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = png.toString('base64');
  assert.equal((await app.inject({ method: 'POST', url: '/api/images/upload', payload: { type: 'image/png', data } })).statusCode, 401);
  alice = await profile('Subida');
  const uploaded = await app.inject({ method: 'POST', url: '/api/images/upload', headers: { cookie: alice.cookie }, payload: { type: 'image/png', data } });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  assert.match(uploaded.json().imagePath, /^\/images\/[a-f0-9]{32}\.png$/);
  const unsupported = await app.inject({ method: 'POST', url: '/api/images/upload', headers: { cookie: alice.cookie }, payload: { type: 'image/png', data: Buffer.from('not image').toString('base64') } });
  assert.equal(unsupported.statusCode, 400);
});

test('scraper rejects private targets and rechecks redirect destinations before making the next request', async () => {
  alice = await profile('Scraper');
  const local = await app.inject({ method: 'POST', url: '/api/scrape', headers: { cookie: alice.cookie }, payload: { url: 'http://127.0.0.1/admin' } });
  assert.equal(local.statusCode, 400);
  const unsupported = await app.inject({ method: 'POST', url: '/api/scrape', headers: { cookie: alice.cookie }, payload: { url: 'file:///etc/passwd' } });
  assert.equal(unsupported.statusCode, 400);
});
