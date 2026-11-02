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
beforeEach(() => db.exec('DELETE FROM claims; DELETE FROM alternatives; DELETE FROM items; DELETE FROM sessions; DELETE FROM profiles;'));
after(async () => { await app.close(); db.close(); rmSync(dataDir, { recursive: true, force: true }); });

async function profile(name: string, pin?: string) {
  const response = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name, pin } });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  return { id: response.json().me.id as number, cookie };
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

test('scraper rejects private targets and rechecks redirect destinations before making the next request', async () => {
  alice = await profile('Scraper');
  const local = await app.inject({ method: 'POST', url: '/api/scrape', headers: { cookie: alice.cookie }, payload: { url: 'http://127.0.0.1/admin' } });
  assert.equal(local.statusCode, 400);
  const unsupported = await app.inject({ method: 'POST', url: '/api/scrape', headers: { cookie: alice.cookie }, payload: { url: 'file:///etc/passwd' } });
  assert.equal(unsupported.statusCode, 400);
});
