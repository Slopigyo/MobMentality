import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { BeefwebError, createBeefwebClient } from '../src/beefweb.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PLAYER = { name: 'foobar2000', version: '1.6.18', pluginVersion: '0.10' };
const PLAYLIST = {
  id: 'fictional-playlist-1',
  index: 0,
  title: 'Fictional source playlist',
  itemCount: 3,
  totalTime: 123.5,
  isCurrent: true,
};

function fictionalCredentials() {
  return {
    username: `fictional-user-${randomBytes(12).toString('hex')}`,
    password: ` fictional-password-${randomBytes(24).toString('hex')}:! `,
  };
}

function expectError(code, status, forbidden = []) {
  return (error) => {
    assert.ok(error instanceof BeefwebError, 'Expected a sanitized BeefwebError');
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.name, 'BeefwebError');
    assert.equal(error.cause, undefined);
    const rendered = `${inspect(error)}\n${JSON.stringify(error)}`;
    for (const value of forbidden) {
      assert.ok(!rendered.includes(value), 'Errors must not disclose supplied or upstream data');
    }
    return true;
  };
}

async function fakeServer(t, handler) {
  const server = http.createServer(handler);
  server.on('clientError', (_error, socket) => socket.destroy());
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  t.after(async () => {
    const stopped = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await stopped;
  });
  return { server, address: `http://127.0.0.1:${server.address().port}` };
}

async function clientFor(t, address, overrides = {}) {
  const client = await createBeefwebClient({ address, ...fictionalCredentials(), ...overrides });
  t.after(() => client.dispose());
  return client;
}

function json(response, value) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function stubRequest(onEnd = () => {}) {
  const request = new EventEmitter();
  request.destroyed = false;
  request.end = () => onEnd(request);
  request.destroy = () => {
    request.destroyed = true;
    return request;
  };
  return request;
}

test('only fixed GET routes receive Basic auth; results expose only picker metadata', { timeout: 5000 }, async (t) => {
  const credentials = fictionalCredentials();
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  const hidden = `fictional-hidden-${randomBytes(12).toString('hex')}`;
  const seen = [];
  let authenticated = true;
  let requestBytes = 0;
  const { address } = await fakeServer(t, (request, response) => {
    authenticated &&= request.headers.authorization === authorization;
    request.on('data', (chunk) => { requestBytes += chunk.length; });
    seen.push({ method: request.method, path: request.url });
    if (request.url === '/api/player') {
      json(response, { player: { info: { ...PLAYER, title: hidden }, activeItem: { path: hidden } }, extra: hidden });
    } else {
      json(response, { playlists: [{ ...PLAYLIST, path: hidden }], extra: hidden });
    }
  });
  const client = await clientFor(t, `${address}/api/`, credentials);
  assert.equal(client.address, address);
  assert.deepEqual(Object.keys(client).sort(), ['address', 'dispose', 'getPlayer', 'getPlaylists']);
  assert.deepEqual(await client.getPlayer('/api/player/stop'), PLAYER);
  assert.deepEqual(await client.getPlaylists('/api/playlists/remove/1'), [{
    id: PLAYLIST.id, title: PLAYLIST.title, itemCount: 3, totalTime: 123.5,
  }]);
  assert.deepEqual(seen, [
    { method: 'GET', path: '/api/player' },
    { method: 'GET', path: '/api/playlists' },
  ]);
  assert.ok(authenticated, 'Both requests must use exactly the fictional Basic credentials');
  assert.equal(requestBytes, 0);
  const publicClient = `${JSON.stringify(client)}\n${inspect(client)}`;
  for (const value of [credentials.username, credentials.password, authorization, hidden]) {
    assert.ok(!publicClient.includes(value), 'Client inspection must not expose credentials or upstream metadata');
  }
});

test('normalizes permitted root/API addresses without contacting numeric hosts', async (t) => {
  let lookups = 0;
  t.mock.method(dns, 'lookup', () => { lookups += 1; });
  const roots = [
    'http://127.0.0.1:8880', 'http://127.255.255.254', 'http://10.0.0.1',
    'http://172.16.0.1', 'https://172.31.255.254', 'http://192.168.1.2',
    'http://[::1]:8880', 'http://[fc00::1]', 'https://[fdff:ffff::1]',
  ];
  for (const root of roots) {
    for (const suffix of ['', '/', '/api', '/api/']) {
      const client = await clientFor(t, `${root}${suffix}`);
      assert.equal(client.address, root);
    }
  }
  const canonical = await clientFor(t, 'HTTP://127.0.0.1:80/api/');
  assert.equal(canonical.address, 'http://127.0.0.1');
  assert.equal(lookups, 0);
});

test('rejects disallowed addresses and URL normalization tricks without DNS or HTTP', async (t) => {
  let lookups = 0;
  let requests = 0;
  t.mock.method(dns, 'lookup', () => { lookups += 1; });
  t.mock.method(http, 'request', () => { requests += 1; });
  const addresses = [
    undefined, null, {}, 12, '', '127.0.0.1:8880', '//127.0.0.1',
    'ftp://127.0.0.1', 'file:///api', 'http:127.0.0.1', 'http:///127.0.0.1',
    ' http://127.0.0.1', 'http://127.0.0.1 ', 'http://127.0.0.1\n',
    'http://fictional-user:fictional-password@127.0.0.1', 'http://@127.0.0.1',
    'http://127.0.0.1?', 'http://127.0.0.1#', 'http://127.0.0.1/api?x=1',
    'http://127.0.0.1/api#x', 'http://127.0.0.1/other', 'http://127.0.0.1/api/player',
    'http://127.0.0.1/API', 'http://127.0.0.1/Api/',
    'http://127.0.0.1/other/../api', 'http://127.0.0.1/%61pi',
    'http://127.0.0.1/./api', 'http://127.0.0.1/api//', 'http://127.0.0.1\\api',
    'http://%6cocalhost', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    'http://999.1.1.1', 'http://-fictional.lan', 'http://fictional..lan',
    `http://${'a'.repeat(64)}.lan`, `http://${'a'.repeat(2049)}`,
    'http://8.8.8.8', 'http://0.0.0.0', 'http://169.254.169.254',
    'http://224.0.0.1', 'http://255.255.255.255', 'http://100.64.0.1',
    'http://172.15.255.255', 'http://172.32.0.1', 'http://192.169.0.1',
    'http://192.0.0.1', 'http://0x08080808', 'http://134744072',
    'http://[::]', 'http://[fe80::1]', 'http://[fe80::1%25eth0]',
    'http://[ff02::1]', 'http://[2001:db8::1]', 'http://[fec0::1]',
    'http://[::ffff:127.0.0.1]', 'http://[::ffff:7f00:1]',
    'http://[::127.0.0.1]', 'http://[64:ff9b::a00:1]',
  ];
  for (const address of addresses) {
    await assert.rejects(
      createBeefwebClient({ address, ...fictionalCredentials() }),
      expectError('INVALID_ADDRESS', 400, typeof address === 'string' && address ? [address] : []),
    );
  }
  for (const options of [undefined, null, [], 'not an options object']) {
    await assert.rejects(createBeefwebClient(options), expectError('INVALID_ADDRESS', 400));
  }
  assert.equal(lookups, 0);
  assert.equal(requests, 0);
});

test('resolves LAN names once, pins requests, preserves Host and prefers IPv4 for localhost', { timeout: 5000 }, async (t) => {
  const hosts = [];
  const { server } = await fakeServer(t, (request, response) => {
    hosts.push(request.headers.host);
    json(response, request.url === '/api/player' ? { player: { info: PLAYER } } : { playlists: [] });
  });
  let lookups = 0;
  const resolvedNames = new Set();
  t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    lookups += 1;
    assert.deepEqual(options, { all: true, verbatim: true });
    if (resolvedNames.has(hostname)) {
      // Fail locally rather than letting a broken implementation make an external connection.
      callback(new Error('Fictional DNS rebinding attempt'));
      return;
    }
    resolvedNames.add(hostname);
    callback(null, [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]);
  });
  for (const hostname of ['LOCALHOST', 'fictional-beefweb.lan', 'fictional-player', 'fictional-player.lan.']) {
    const client = await clientFor(t, `http://${hostname}:${server.address().port}/api`);
    assert.deepEqual(await client.getPlayer(), PLAYER);
    assert.deepEqual(await client.getPlaylists(), []);
    assert.equal(client.address, `http://${hostname.toLowerCase()}:${server.address().port}`);
  }
  assert.equal(lookups, 4);
  assert.equal(hosts.length, 8);
  assert.ok(hosts.every((host) => !host.startsWith('127.0.0.1')), 'Host must remain the original hostname');
});

test('rejects hostname resolution if any result is unsafe, malformed or absent', async (t) => {
  const invalidResults = [
    [], null, {}, [null], [{ address: '127.0.0.1', family: 6 }],
    [{ address: 'not-an-IP', family: 4 }], [{ address: '8.8.8.8', family: 4 }],
    [{ address: '127.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }],
    [{ address: '127.0.0.1', family: 4 }, { address: 'fe80::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: 'fd00::1%eth0', family: 6 }],
  ];
  let result;
  t.mock.method(dns, 'lookup', (_hostname, _options, callback) => callback(null, result));
  for (result of invalidResults) {
    await assert.rejects(
      createBeefwebClient({ address: 'http://fictional-beefweb.lan', ...fictionalCredentials() }),
      expectError('INVALID_ADDRESS', 400, ['fictional-beefweb.lan']),
    );
  }
});

test('DNS failures and deadlines are sanitized; late resolution makes no request', { timeout: 5000 }, async (t) => {
  const hidden = 'fictional-sensitive-DNS-detail';
  const lookup = t.mock.method(dns, 'lookup', (_hostname, _options, callback) => callback(new Error(hidden)));
  await assert.rejects(
    createBeefwebClient({ address: 'http://fictional-beefweb.lan', ...fictionalCredentials() }),
    expectError('BEEFWEB_UNREACHABLE', 502, [hidden, 'fictional-beefweb.lan']),
  );
  let lateCallback;
  let requests = 0;
  lookup.mock.mockImplementation((_hostname, _options, callback) => { lateCallback = callback; });
  t.mock.method(http, 'request', () => { requests += 1; });
  await assert.rejects(
    createBeefwebClient({ address: 'http://fictional-beefweb.lan', ...fictionalCredentials(), timeoutMs: 30 }),
    expectError('BEEFWEB_TIMEOUT', 504),
  );
  lateCallback(null, [{ address: '127.0.0.1', family: 4 }]);
  assert.equal(requests, 0);
});

test('validates credential types, length, colon and username controls before DNS', async (t) => {
  let lookups = 0;
  t.mock.method(dns, 'lookup', () => { lookups += 1; });
  const valid = fictionalCredentials();
  const invalid = [
    ...[undefined, null, 3, '', 'u'.repeat(257), 'fictional:user', 'fictional\nuser',
      'fictional\ruser', 'fictional\tuser', 'fictional\0user', 'fictional\u007fuser',
      'fictional\u0085user'].map((username) => ({ ...valid, username })),
    ...[undefined, null, 3, '', 'p'.repeat(1025)].map((password) => ({ ...valid, password })),
  ];
  for (const credentials of invalid) {
    await assert.rejects(
      createBeefwebClient({ address: 'http://fictional-beefweb.lan', ...credentials }),
      expectError('INVALID_CREDENTIALS', 400, [valid.username, valid.password]),
    );
  }
  assert.equal(lookups, 0);
});

test('preserves password whitespace and colon and accepts boundary credential lengths', { timeout: 5000 }, async (t) => {
  let expected;
  let matched = true;
  const { address } = await fakeServer(t, (request, response) => {
    matched &&= request.headers.authorization === expected;
    json(response, { player: { info: PLAYER } });
  });
  const credentials = [
    fictionalCredentials(),
    { username: 'fictional-user'.padEnd(256, 'x'), password: ' fictional-password'.padEnd(1023, 'x') + ' ' },
    { username: 'fictional-üser', password: ' : fictional-pässword\0\r\n ' },
    { username: 'fictional-user', password: ' ' },
  ];
  for (const value of credentials) {
    expected = `Basic ${Buffer.from(`${value.username}:${value.password}`, 'utf8').toString('base64')}`;
    const client = await clientFor(t, address, value);
    await client.getPlayer();
  }
  assert.ok(matched, 'Credentials must be encoded unchanged');
});

test('requires foobar2000 identity and bounded version strings, allowing newer plugins', { timeout: 5000 }, async (t) => {
  let payload;
  const { address } = await fakeServer(t, (_request, response) => json(response, payload));
  const client = await clientFor(t, address);
  for (const pluginVersion of ['0.10', '0.11', '1.0.0', '1.1-beta']) {
    payload = { player: { info: { ...PLAYER, pluginVersion } } };
    assert.deepEqual(await client.getPlayer(), { ...PLAYER, pluginVersion });
  }
  const invalid = [
    null, [], {}, { player: [] }, { player: null }, { player: {} },
    { player: { info: [] } }, { player: { info: PLAYER.name } },
    ...[
      { name: 'DeaDBeeF' }, { name: 'Foobar2000' }, { name: null },
      { version: '' }, { version: ' ' }, { version: 1.6 }, { version: 'x'.repeat(129) },
      { version: 'fictional\nversion' }, { pluginVersion: undefined }, { pluginVersion: '' },
      { pluginVersion: null }, { pluginVersion: 0.10 }, { pluginVersion: 'x'.repeat(129) },
    ].map((info) => ({ player: { info: { ...PLAYER, ...info } } })),
  ];
  for (payload of invalid) {
    await assert.rejects(client.getPlayer(), expectError('BEEFWEB_INVALID_RESPONSE', 502));
  }
});

test('validates playlist shapes, lengths, finite nonnegative counts and unique IDs', { timeout: 5000 }, async (t) => {
  let payload;
  const { address } = await fakeServer(t, (_request, response) => json(response, payload));
  const client = await clientFor(t, address);
  payload = { playlists: [] };
  assert.deepEqual(await client.getPlaylists(), []);
  payload = { playlists: [{ ...PLAYLIST, title: '', itemCount: 0, totalTime: 0 }] };
  assert.deepEqual(await client.getPlaylists(), [{ id: PLAYLIST.id, title: '', itemCount: 0, totalTime: 0 }]);
  payload = { playlists: [{ ...PLAYLIST, id: 'i'.repeat(256), title: 't'.repeat(4096) }] };
  assert.equal((await client.getPlaylists()).length, 1);
  const invalid = [
    null, [], {}, { playlists: null }, { playlists: {} }, { playlists: [null] }, { playlists: [[]] },
    { playlists: [PLAYLIST, { ...PLAYLIST, index: 1 }] },
    { playlists: Array.from({ length: 10_001 }, (_value, index) => ({ ...PLAYLIST, id: `fixture-${index}`, index })) },
    ...[
      { id: '' }, { id: ' ' }, { id: 1 }, { id: 'i'.repeat(257) }, { id: 'fictional\0id' },
      { title: undefined }, { title: null }, { title: 't'.repeat(4097) }, { title: 'fictional\0title' },
      { index: undefined }, { index: -1 }, { index: 1.5 }, { index: '0' },
      { isCurrent: undefined }, { isCurrent: 'true' },
      { itemCount: undefined }, { itemCount: -1 }, { itemCount: 1.5 }, { itemCount: '3' },
      { itemCount: Number.MAX_SAFE_INTEGER + 1 }, { itemCount: NaN }, { itemCount: Infinity },
      { totalTime: undefined }, { totalTime: -1 }, { totalTime: '123' }, { totalTime: NaN },
      { totalTime: Infinity },
    ].map((playlist) => ({ playlists: [{ ...PLAYLIST, ...playlist }] })),
  ];
  for (payload of invalid) {
    await assert.rejects(client.getPlaylists(), expectError('BEEFWEB_INVALID_RESPONSE', 502));
  }
});

test('authentication, permission, redirect and other HTTP failures use safe local statuses', { timeout: 5000 }, async (t) => {
  const hidden = 'fictional-private-response-detail';
  let upstreamStatus;
  let requests = 0;
  const { address } = await fakeServer(t, (_request, response) => {
    requests += 1;
    response.writeHead(upstreamStatus, { 'X-Fixture-Private': hidden });
    response.end(hidden);
  });
  const credentials = fictionalCredentials();
  const client = await clientFor(t, address, credentials);
  const cases = [
    [401, 'BEEFWEB_AUTHENTICATION_FAILED', 401], [403, 'BEEFWEB_FORBIDDEN', 403],
    ...[300, 301, 302, 303, 304, 305, 307, 308].map((status) => [status, 'BEEFWEB_REDIRECT', 502]),
    ...[204, 400, 404, 429, 500, 503].map((status) => [status, 'BEEFWEB_ERROR', 502]),
  ];
  for (const [status, code, localStatus] of cases) {
    upstreamStatus = status;
    await assert.rejects(client.getPlayer(), expectError(code, localStatus, [
      hidden, address, credentials.username, credentials.password,
    ]));
  }
  assert.equal(requests, cases.length, 'Failures must not trigger retries');
});

test('never follows redirects or sends credentials to the redirect destination', { timeout: 5000 }, async (t) => {
  let destinationRequests = 0;
  const destination = await fakeServer(t, (_request, response) => {
    destinationRequests += 1;
    response.end();
  });
  let sourceRequests = 0;
  const source = await fakeServer(t, (_request, response) => {
    sourceRequests += 1;
    response.writeHead(302, { Location: `${destination.address}/fictional-credential-capture` });
    response.end();
  });
  const client = await clientFor(t, source.address);
  await assert.rejects(client.getPlayer(), expectError('BEEFWEB_REDIRECT', 502, [destination.address]));
  assert.equal(sourceRequests, 1);
  assert.equal(destinationRequests, 0);
});

test('rejects malformed JSON, invalid UTF-8, unsupported encoding and nonfinite JSON numbers', { timeout: 5000 }, async (t) => {
  let body;
  let encoding;
  const { address } = await fakeServer(t, (_request, response) => {
    if (encoding) response.setHeader('Content-Encoding', encoding);
    response.end(body);
  });
  const client = await clientFor(t, address);
  for (body of ['', '{fictional-invalid-json', 'null', '[]', Buffer.from([0xc3, 0x28])]) {
    await assert.rejects(client.getPlayer(), expectError('BEEFWEB_INVALID_RESPONSE', 502, ['fictional-invalid-json']));
  }
  body = JSON.stringify({ playlists: [PLAYLIST] }).replace('123.5', '1e400');
  await assert.rejects(client.getPlaylists(), expectError('BEEFWEB_INVALID_RESPONSE', 502));
  body = JSON.stringify({ player: { info: PLAYER } });
  encoding = 'gzip';
  await assert.rejects(client.getPlayer(), expectError('BEEFWEB_INVALID_RESPONSE', 502));
});

test('rejects oversized advertised and streaming bodies; accepts exactly 2 MiB', { timeout: 5000 }, async (t) => {
  let mode = 'advertised';
  const { address } = await fakeServer(t, (_request, response) => {
    if (mode === 'advertised') {
      response.writeHead(200, { 'Content-Length': MAX_BODY_BYTES + 1 });
      response.flushHeaders();
    } else if (mode === 'streamed') {
      response.write(Buffer.alloc(MAX_BODY_BYTES / 2, ' '));
      response.write(Buffer.alloc(MAX_BODY_BYTES / 2, ' '));
      response.end(' ');
    } else {
      const body = Buffer.alloc(MAX_BODY_BYTES, ' ');
      body.write(JSON.stringify({ player: { info: PLAYER } }));
      response.end(body);
    }
  });
  const client = await clientFor(t, address);
  await assert.rejects(client.getPlayer(), expectError('BEEFWEB_INVALID_RESPONSE', 502));
  mode = 'streamed';
  await assert.rejects(client.getPlayer(), expectError('BEEFWEB_INVALID_RESPONSE', 502));
  mode = 'exact';
  assert.deepEqual(await client.getPlayer(), PLAYER);
});

test('rejects truncated and malformed HTTP responses without exposing parser errors', { timeout: 5000 }, async (t) => {
  let mode = 'truncated';
  const { address } = await fakeServer(t, (request, response) => {
    if (mode === 'truncated') {
      response.writeHead(200, { 'Content-Length': 1000 });
      response.write('{"fictional-private-detail":');
      setImmediate(() => response.destroy());
    } else {
      request.socket.end('HTTP/1.1 200 OK\r\nContent-Length: fictional-private-detail\r\n\r\n');
    }
  });
  const client = await clientFor(t, address);
  await assert.rejects(client.getPlayer(), expectError('BEEFWEB_INVALID_RESPONSE', 502, ['fictional-private-detail']));
  mode = 'malformed';
  await assert.rejects(client.getPlayer(), expectError('BEEFWEB_INVALID_RESPONSE', 502, ['fictional-private-detail']));
});

test('connection failures are sanitized and not retried', { timeout: 5000 }, async (t) => {
  let requests = 0;
  const { address } = await fakeServer(t, (request) => {
    requests += 1;
    request.socket.destroy();
  });
  const client = await clientFor(t, address);
  await assert.rejects(client.getPlayer(), expectError('BEEFWEB_UNREACHABLE', 502, [address]));
  assert.equal(requests, 1);
});

test('HTTPS keeps certificate verification, original identity, DNS pinning and proxy isolation', async (t) => {
  t.mock.method(dns, 'lookup', (_hostname, _options, callback) => {
    callback(null, [{ address: '192.168.10.2', family: 4 }]);
  });
  let requests = 0;
  t.mock.method(https, 'request', (options) => {
    requests += 1;
    assert.equal(options.hostname, 'fictional-beefweb.lan');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.autoSelectFamily, false);
    assert.notEqual(options.agent, https.globalAgent);
    assert.deepEqual(options.agent.options.proxyEnv, {});
    options.lookup(options.hostname, { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: '192.168.10.2', family: 4 }]);
    });
    options.lookup(options.hostname, {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, '192.168.10.2');
      assert.equal(family, 4);
    });
    return stubRequest((request) => queueMicrotask(() => {
      const error = new Error('fictional-private-certificate-detail');
      error.code = 'CERT_HAS_EXPIRED';
      request.emit('error', error);
    }));
  });
  const client = await clientFor(t, 'https://fictional-beefweb.lan/api');
  await assert.rejects(client.getPlayer(), expectError('BEEFWEB_UNREACHABLE', 502, [
    'fictional-beefweb.lan', 'fictional-private-certificate-detail',
  ]));
  assert.equal(requests, 1);
});

test('HTTP uses an isolated non-proxy agent and sanitizes unexpected transport failures', async (t) => {
  let agent;
  t.mock.method(http, 'request', (options) => {
    agent = options.agent;
    throw new Error('fictional-private-transport-detail');
  });
  const client = await clientFor(t, 'http://127.0.0.1');
  await assert.rejects(client.getPlayer(), expectError('BEEFWEB_ERROR', 502, ['fictional-private-transport-detail']));
  assert.notEqual(agent, http.globalAgent);
  assert.deepEqual(agent.options.proxyEnv, {});
});

test('request deadlines cover missing headers and continuous slow streaming', { timeout: 5000 }, async (t) => {
  let streaming = false;
  let requests = 0;
  const { address } = await fakeServer(t, (_request, response) => {
    requests += 1;
    if (streaming) {
      response.writeHead(200);
      response.write('{');
      const interval = setInterval(() => response.write(' '), 5);
      response.once('close', () => clearInterval(interval));
      t.after(() => clearInterval(interval));
    }
  });
  const client = await clientFor(t, address, { timeoutMs: 75 });
  await assert.rejects(client.getPlayer(), expectError('BEEFWEB_TIMEOUT', 504));
  streaming = true;
  const start = performance.now();
  await assert.rejects(client.getPlaylists(), expectError('BEEFWEB_TIMEOUT', 504));
  assert.ok(performance.now() - start < 2000, 'Streaming must not reset the total deadline');
  assert.equal(requests, 2);
});

test('defaults to a 5000 ms deadline and destroys timed-out requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = stubRequest();
  t.mock.method(http, 'request', () => request);
  const client = await clientFor(t, 'http://127.0.0.1');
  const rejected = assert.rejects(client.getPlayer(), expectError('BEEFWEB_TIMEOUT', 504));
  t.mock.timers.tick(4999);
  assert.equal(request.destroyed, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(request.destroyed, true);
});

test('invalid timeout values cannot disable deadlines or overflow Node timers', async () => {
  for (const timeoutMs of [0, -1, 1.5, Infinity, NaN, '5000', 2_147_483_648]) {
    await assert.rejects(
      createBeefwebClient({ address: 'http://127.0.0.1', ...fictionalCredentials(), timeoutMs }),
      expectError('BEEFWEB_ERROR', 502),
    );
  }
});

test('dispose aborts concurrent requests, is idempotent and permanently closes the client', { timeout: 5000 }, async (t) => {
  let requests = 0;
  let receivedBoth;
  const both = new Promise((resolve) => { receivedBoth = resolve; });
  const { address } = await fakeServer(t, (_request, response) => {
    requests += 1;
    response.writeHead(200);
    response.write('{');
    if (requests === 2) receivedBoth();
  });
  const client = await clientFor(t, address, { timeoutMs: 2000 });
  const player = assert.rejects(client.getPlayer(), expectError('CONNECTION_CLOSED', 409));
  const playlists = assert.rejects(client.getPlaylists(), expectError('CONNECTION_CLOSED', 409));
  await both;
  assert.equal(client.dispose(), undefined);
  assert.equal(client.dispose(), undefined);
  await Promise.all([player, playlists]);
  await assert.rejects(client.getPlayer(), expectError('CONNECTION_CLOSED', 409));
  await assert.rejects(client.getPlaylists(), expectError('CONNECTION_CLOSED', 409));
  assert.equal(requests, 2);
});

test('dispose before any request sends nothing and destroys pending transport objects', async (t) => {
  let requests = 0;
  const request = stubRequest();
  t.mock.method(http, 'request', () => {
    requests += 1;
    return request;
  });
  const unused = await clientFor(t, 'http://127.0.0.1');
  unused.dispose();
  await assert.rejects(unused.getPlayer(), expectError('CONNECTION_CLOSED', 409));
  assert.equal(requests, 0);
  const active = await clientFor(t, 'http://127.0.0.1');
  const rejected = assert.rejects(active.getPlayer(), expectError('CONNECTION_CLOSED', 409));
  active.dispose();
  await rejected;
  assert.equal(request.destroyed, true);
  assert.equal(requests, 1);
});

test('transport timeout errors use the same sanitized deadline status', async (t) => {
  let errorCode;
  const failure = () => Object.assign(new Error('fictional-private-timeout-detail'), { code: errorCode });
  t.mock.method(dns, 'lookup', (_hostname, _options, callback) => callback(failure()));
  t.mock.method(http, 'request', () => stubRequest((request) => {
    queueMicrotask(() => request.emit('error', failure()));
  }));
  for (errorCode of ['ETIMEOUT', 'ETIMEDOUT']) {
    await assert.rejects(
      createBeefwebClient({ address: 'http://fictional-beefweb.lan', ...fictionalCredentials() }),
      expectError('BEEFWEB_TIMEOUT', 504, ['fictional-private-timeout-detail']),
    );
    const client = await clientFor(t, 'http://127.0.0.1');
    await assert.rejects(client.getPlayer(), expectError('BEEFWEB_TIMEOUT', 504, ['fictional-private-timeout-detail']));
  }
});

test('rejects protocol upgrades instead of leaving an upgraded socket open', { timeout: 5000 }, async (t) => {
  const { address } = await fakeServer(t, (_request, response) => {
    response.writeHead(101, { Connection: 'Upgrade', Upgrade: 'fictional-protocol' });
    response.end();
  });
  const client = await clientFor(t, address, { timeoutMs: 100 });
  await assert.rejects(client.getPlayer(), expectError('BEEFWEB_ERROR', 502));
});

test('bypasses a proxy-enabled global agent instead of forwarding credentials through it', { timeout: 5000 }, async (t) => {
  let proxyRequests = 0;
  let directRequests = 0;
  const proxy = await fakeServer(t, (_request, response) => {
    proxyRequests += 1;
    json(response, { player: { info: PLAYER } });
  });
  const direct = await fakeServer(t, (_request, response) => {
    directRequests += 1;
    json(response, { player: { info: PLAYER } });
  });
  const previousAgent = http.globalAgent;
  const proxyAgent = new http.Agent({ proxyEnv: { http_proxy: proxy.address, no_proxy: '' } });
  http.globalAgent = proxyAgent;
  t.after(() => {
    http.globalAgent = previousAgent;
    proxyAgent.destroy();
  });
  // An unauthenticated control request proves the global proxy is active, using fake servers only.
  await new Promise((resolve, reject) => {
    const request = http.get(`${direct.address}/api/player`, (response) => {
      response.on('error', reject);
      response.on('end', resolve);
      response.resume();
    });
    request.on('error', reject);
    request.setTimeout(1000, () => request.destroy(new Error('Fictional proxy probe timed out')));
  });
  assert.equal(proxyRequests, 1);
  assert.equal(directRequests, 0);
  const client = await clientFor(t, direct.address);
  assert.deepEqual(await client.getPlayer(), PLAYER);
  assert.equal(proxyRequests, 1, 'The client must bypass the global proxy');
  assert.equal(directRequests, 1);
});

test('BeefwebError never accepts arbitrary messages, codes or upstream status values', () => {
  for (const code of [undefined, 'fictional-private-error', '__proto__', 'constructor', {}, 401]) {
    const error = new BeefwebError(code);
    expectError('BEEFWEB_ERROR', 502, ['fictional-private-error'])(error);
  }
});
