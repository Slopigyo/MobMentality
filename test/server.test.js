import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';

const player = { name: 'foobar2000', version: '1.6.18', pluginVersion: '0.10' };
const playlists = [
  { id: 'p1', index: 0, title: 'Fictional source', itemCount: 3, totalTime: 600, isCurrent: true },
  { id: 'empty', index: 1, title: 'Empty source', itemCount: 0, totalTime: 0, isCurrent: false },
  { id: 'p2', index: 2, title: '<img src=x onerror=alert(1)>', itemCount: 1, totalTime: 180, isCurrent: false },
];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}

async function fixture(t, options = {}) {
  const username = `fixture-${randomBytes(8).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const state = { requests: [], playlists: structuredClone(playlists), status: 200 };
  const upstream = http.createServer((request, response) => {
    state.requests.push({ method: request.method, path: request.url });
    if (request.headers.authorization !== authorization) {
      response.writeHead(401); response.end('Do not relay upstream error details'); return;
    }
    if (state.status !== 200) {
      response.writeHead(state.status); response.end('Do not relay upstream error details'); return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET') {
      response.writeHead(500); response.end();
    } else if (request.url === '/api/player') {
      response.end(JSON.stringify({ player: { info: player, activeItem: { columns: ['Private fixture metadata'] } } }));
    } else if (request.url === '/api/playlists') {
      response.end(JSON.stringify({ playlists: state.playlists }));
    } else { response.writeHead(404); response.end(); }
  });
  const address = await listen(upstream);
  const app = await createApp(options);
  const origin = await listen(app);
  t.after(async () => { await close(app); await close(upstream); });

  async function request(path, { method = 'GET', token, body, headers = {}, includeOrigin = true, includeClient = true } = {}) {
    const allHeaders = { ...headers };
    if (includeClient) allHeaders['X-MobMentality-Client'] = '1';
    if (includeOrigin && method !== 'GET' && !Object.hasOwn(allHeaders, 'Origin')) allHeaders.Origin = origin;
    if (token) allHeaders['X-MobMentality-Session'] = token;
    if (body !== undefined && !Object.hasOwn(allHeaders, 'Content-Type')) allHeaders['Content-Type'] = 'application/json';
    return fetch(origin + path, {
      method, headers: allHeaders,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  }

  async function connect(extra = {}) {
    const response = await request('/api/connect', { method: 'POST', body: { address, username, password, ...extra } });
    return { response, data: await response.json() };
  }
  return { request, connect, state, username, password, address, origin, app };
}

test('serves a host-only console with no-cache and restrictive security headers', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/', { includeClient: false });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  const html = await response.text();
  assert.match(html, /type="password"/);
  assert.match(html, /id="connection-fields" disabled/);
  for (const asset of ['/app.js', '/styles.css']) assert.equal((await f.request(asset)).status, 200);
  assert.deepEqual(f.state.requests, []);
});

test('connects with supplied credentials and returns only picker metadata', async (t) => {
  const f = await fixture(t);
  const { response, data } = await f.connect();
  assert.equal(response.status, 200);
  assert.match(data.sessionToken, /^[a-f0-9]{64}$/);
  assert.deepEqual(data.connection, { address: f.address, player });
  assert.equal(data.idleTimeoutSeconds, 1800);
  assert.equal(data.selectedPlaylist, null);
  assert.deepEqual(Object.keys(data.playlists[0]).sort(), ['id', 'itemCount', 'title', 'totalTime']);
  const serialized = JSON.stringify(data);
  assert.ok(!serialized.includes(f.password));
  assert.ok(!serialized.includes(f.username));
  assert.ok(!serialized.includes('Private fixture metadata'));
  assert.deepEqual(f.state.requests.map((r) => r.path).sort(), ['/api/player', '/api/playlists']);
});

test('source selection stays in the app and only sends fixed GET requests upstream', async (t) => {
  const f = await fixture(t);
  const { data } = await f.connect();
  const response = await f.request('/api/source', { method: 'POST', token: data.sessionToken, body: { playlistId: 'p2' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).selectedPlaylist.id, 'p2');
  const refresh = await f.request('/api/playlists', { token: data.sessionToken });
  assert.equal((await refresh.json()).selectedPlaylist.id, 'p2');
  assert.deepEqual(f.state.playlists, playlists);
  assert.ok(f.state.requests.every((r) => r.method === 'GET' && ['/api/player', '/api/playlists'].includes(r.path)));
});

test('refresh clears a removed or newly empty selected source', async (t) => {
  const f = await fixture(t);
  const { data } = await f.connect();
  const token = data.sessionToken;
  await f.request('/api/source', { method: 'POST', token, body: { playlistId: 'p1' } });
  f.state.playlists[0].itemCount = 0;
  let response = await f.request('/api/playlists', { token });
  let result = await response.json();
  assert.equal(result.selectionCleared, true);
  assert.equal(result.selectedPlaylist, null);
  await f.request('/api/source', { method: 'POST', token, body: { playlistId: 'p2' } });
  f.state.playlists = [];
  response = await f.request('/api/playlists', { token });
  result = await response.json();
  assert.equal(result.selectionCleared, true);
  assert.deepEqual(result.playlists, []);
});

test('rejects missing, empty and invalid source IDs without mutating the player', async (t) => {
  const f = await fixture(t);
  const { data } = await f.connect();
  for (const [playlistId, status, code] of [
    ['missing', 409, 'PLAYLIST_MISSING'], ['empty', 409, 'EMPTY_PLAYLIST'], [{ id: 'p1' }, 400, 'INVALID_REQUEST'],
  ]) {
    const response = await f.request('/api/source', { method: 'POST', token: data.sessionToken, body: { playlistId } });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
  assert.deepEqual(f.state.playlists, playlists);
});

test('authentication and permission failures are distinct and sanitized', async (t) => {
  const f = await fixture(t);
  let result = await f.connect({ password: randomBytes(24).toString('hex') });
  assert.equal(result.response.status, 401);
  assert.equal(result.data.error.code, 'BEEFWEB_AUTHENTICATION_FAILED');
  assert.ok(!JSON.stringify(result.data).includes('upstream error details'));
  f.state.status = 403;
  result = await f.connect();
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'BEEFWEB_FORBIDDEN');
});

test('revoked upstream credentials dispose the app session', async (t) => {
  const f = await fixture(t);
  const { data } = await f.connect();
  f.state.status = 401;
  const first = await f.request('/api/playlists', { token: data.sessionToken });
  assert.equal((await first.json()).error.code, 'BEEFWEB_AUTHENTICATION_FAILED');
  const count = f.state.requests.length;
  const second = await f.request('/api/playlists', { token: data.sessionToken });
  assert.equal((await second.json()).error.code, 'SESSION_EXPIRED');
  assert.equal(f.state.requests.length, count);
});

test('disconnect is idempotent, destroys access, and sends no upstream command', async (t) => {
  const f = await fixture(t);
  const { data } = await f.connect();
  const count = f.state.requests.length;
  for (let i = 0; i < 2; i += 1) {
    const response = await f.request('/api/disconnect', { method: 'POST', token: data.sessionToken, body: {} });
    assert.deepEqual(await response.json(), { disconnected: true });
  }
  const response = await f.request('/api/playlists', { token: data.sessionToken });
  assert.equal(response.status, 401);
  assert.equal(f.state.requests.length, count);
});

test('idle expiry rejects access without contacting Beefweb again', async (t) => {
  let time = 100;
  const f = await fixture(t, { now: () => time });
  const { data } = await f.connect();
  time += 30 * 60 * 1000;
  const count = f.state.requests.length;
  const response = await f.request('/api/playlists', { token: data.sessionToken });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'SESSION_EXPIRED');
  assert.equal(f.state.requests.length, count);
});

test('source choices are isolated between in-memory sessions', async (t) => {
  const f = await fixture(t);
  const first = await f.connect();
  const second = await f.connect();
  assert.notEqual(first.data.sessionToken, second.data.sessionToken);
  await f.request('/api/source', { method: 'POST', token: first.data.sessionToken, body: { playlistId: 'p1' } });
  const response = await f.request('/api/playlists', { token: second.data.sessionToken });
  assert.equal((await response.json()).selectedPlaylist, null);
});

test('rejects cross-origin, missing-origin and simple requests before connecting', async (t) => {
  const f = await fixture(t);
  const cases = [
    { headers: { Origin: 'https://untrusted.invalid' } },
    { includeOrigin: false },
    { includeClient: false },
    { headers: { Origin: 'null' } },
  ];
  for (const extra of cases) {
    const response = await f.request('/api/connect', { method: 'POST', body: {}, ...extra });
    assert.equal(response.status, 403);
  }
  assert.deepEqual(f.state.requests, []);
});

test('rejects DNS-rebinding Host headers even for the static console', async (t) => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const request = http.get(f.origin, { headers: { Host: 'untrusted.invalid' } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(status, 403);
  assert.deepEqual(f.state.requests, []);
});

test('rejects invalid, non-JSON and oversized bodies without relaying input', async (t) => {
  const f = await fixture(t);
  for (const [body, headers, status] of [
    ['not-json', {}, 400], [[], {}, 400], [{}, { 'Content-Type': 'text/plain' }, 415],
    [{ padding: 'x'.repeat(9000) }, {}, 413],
  ]) {
    const response = await f.request('/api/connect', { method: 'POST', body, headers });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  }
  assert.deepEqual(f.state.requests, []);
});

test('has no playback, arbitrary proxy, configuration or filesystem routes', async (t) => {
  const f = await fixture(t);
  for (const path of ['/api/player/stop', '/api/proxy', '/api/config', '/api/browser/roots', '/api/connect?address=secret']) {
    assert.equal((await f.request(path, { method: 'POST', body: {} })).status, 404);
  }
  assert.equal((await f.request('/src/server.js')).status, 404);
  assert.equal((await f.request('/api/playlists')).status, 401);
  assert.deepEqual(f.state.requests, []);
});

test('bounds abandoned sessions and sanitizes unexpected local failures', async (t) => {
  const f = await fixture(t, { maxSessions: 1 });
  await f.connect();
  const count = f.state.requests.length;
  const result = await f.connect();
  assert.equal(result.response.status, 429);
  assert.equal(result.data.error.code, 'SESSION_LIMIT');
  assert.equal(f.state.requests.length, count);
  const broken = await fixture(t, { createClient: async () => { throw new Error('private internal details'); } });
  const failed = await broken.connect();
  assert.equal(failed.response.status, 500);
  assert.ok(!JSON.stringify(failed.data).includes('private internal details'));
});

test('disconnect during refresh cannot resurrect a session; competing reads are bounded', async (t) => {
  let calls = 0;
  let disposed = 0;
  let release;
  let started;
  const pending = new Promise((resolve) => { release = resolve; });
  const reading = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, {
    createClient: async () => ({
      address: 'http://127.0.0.1',
      getPlayer: async () => player,
      getPlaylists: async () => { calls += 1; if (calls === 2) { started(); await pending; } return playlists; },
      dispose: () => { disposed += 1; },
    }),
  });
  const { data } = await f.connect();
  const refresh = f.request('/api/playlists', { token: data.sessionToken });
  await reading;
  const competing = await f.request('/api/playlists', { token: data.sessionToken });
  assert.equal(competing.status, 409);
  const disconnect = await f.request('/api/disconnect', { method: 'POST', token: data.sessionToken, body: {} });
  assert.equal(disconnect.status, 200);
  release();
  const response = await refresh;
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'SESSION_EXPIRED');
  assert.equal(disposed, 1);
});

test('a slow source request cannot renew a session after its idle deadline', async (t) => {
  let time = 100;
  let reads = 0;
  let disposed = 0;
  const f = await fixture(t, {
    now: () => time,
    createClient: async () => ({
      address: 'http://127.0.0.1',
      getPlayer: async () => player,
      getPlaylists: async () => { reads += 1; return playlists; },
      dispose: () => { disposed += 1; },
    }),
  });
  const { data } = await f.connect();
  const deadline = time + 30 * 60 * 1000;
  time = deadline - 1;
  const body = JSON.stringify({ playlistId: 'p1' });
  const arrived = new Promise((resolve) => f.app.once('request', resolve));
  let outgoing;
  const result = new Promise((resolve, reject) => {
    outgoing = http.request(f.origin + '/api/source', {
      method: 'POST',
      headers: {
        Origin: f.origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'X-MobMentality-Client': '1', 'X-MobMentality-Session': data.sessionToken,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Fixture request timed out')));
    outgoing.flushHeaders();
  });
  await arrived;
  time = deadline + 1;
  outgoing.end(body);
  const response = await result;
  assert.equal(response.status, 401);
  assert.equal(response.data.error.code, 'SESSION_EXPIRED');
  assert.equal(reads, 1);
  assert.equal(disposed, 1);
});
