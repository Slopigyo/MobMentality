// Optional, dependency-free check: node scripts/browser-smoke.js "<path to Firefox>"
// Firefox's Remote Agent is loopback-only; port 0 is allocated by the OS.
// https://firefox-source-docs.mozilla.org/remote/Security.html
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { urlToHttpOptions } from 'node:url';

const SUITE_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = 10_000;
const ALLOWED_UPSTREAM_PATHS = new Set(['/api/player', '/api/playlists']);
const APP_ROUTES = new Set(['/api/connect', '/api/playlists', '/api/source', '/api/disconnect']);
const PLAYER = { name: 'foobar2000', version: '1.6.18', pluginVersion: '0.10' };
const SOURCE_ID = 'smoke-source';
const CURRENT_ID = 'smoke-current';
const EMPTY_ID = 'smoke-empty';
const HOSTILE_TITLE = '</option><img src="/smoke-xss" onerror="globalThis.__mmSmokeXss=true"><script>globalThis.__mmSmokeXss=true</script>';

class SmokeFailure extends Error {}

function check(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

// Never propagate transport errors, assertion values, script expressions or browser logs.
function bounded(promise, milliseconds, message, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (error) rejectPromise(error instanceof SmokeFailure ? error : new SmokeFailure(message));
      else resolvePromise(value);
    };
    const aborted = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new SmokeFailure(message)), milliseconds);
    signal?.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then((value) => finish(null, value), (error) => finish(error));
    if (signal?.aborted) aborted();
  });
}

function trackServer(server, resources) {
  check(server instanceof http.Server, 'createApp() did not return a Node HTTP server.');
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  resources.servers.push({ server, sockets });
  return server;
}

async function listen(server, signal) {
  await bounded(new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectPromise);
      resolvePromise();
    });
  }), 5_000, 'A loopback test server could not start.', signal);
  return `http://127.0.0.1:${server.address().port}`;
}

function makeFixture(resources) {
  const credentials = {
    username: `fictional-${randomBytes(12).toString('hex')}`,
    password: ` fictional-${randomBytes(24).toString('hex')}:! `,
  };
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  const fixture = {
    credentials,
    wrongPassword: `wrong-${randomBytes(24).toString('hex')}`,
    forceUnauthorized: false,
    requests: [],
    unexpectedBody: false,
    playlists: [
      { id: CURRENT_ID, index: 0, title: 'Fictional current playlist', itemCount: 2, totalTime: 300, isCurrent: true },
      { id: SOURCE_ID, index: 1, title: HOSTILE_TITLE, itemCount: 7, totalTime: 1260.5, isCurrent: false },
      { id: EMPTY_ID, index: 2, title: 'Fictional empty playlist', itemCount: 0, totalTime: 0, isCurrent: false },
    ],
  };
  fixture.server = trackServer(http.createServer((request, response) => {
    const allowed = request.method === 'GET' && ALLOWED_UPSTREAM_PATHS.has(request.url);
    const authorized = request.headers.authorization === authorization && !fixture.forceUnauthorized;
    // Keep only categorical observations, never request headers or bodies.
    fixture.requests.push({ allowed, authorized, path: allowed ? request.url : 'unexpected' });
    request.on('data', (chunk) => { fixture.unexpectedBody ||= chunk.length > 0; });
    request.on('error', () => {});
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (!allowed) {
      response.writeHead(404).end('{}');
    } else if (!authorized) {
      response.setHeader('WWW-Authenticate', 'Basic realm="Fictional smoke fixture"');
      response.writeHead(401).end('{}');
    } else {
      const body = request.url === '/api/player'
        ? { player: { info: PLAYER } }
        : { playlists: fixture.playlists };
      response.end(JSON.stringify(body));
    }
  }), resources);
  return fixture;
}

function restrictBackendNetwork(fixtureOrigin) {
  const port = Number(new URL(fixtureOrigin).port);
  let blocked = false;
  const originals = [];
  const originalFetch = globalThis.fetch;
  const reject = () => {
    blocked = true;
    throw new SmokeFailure('An outbound request outside the read-only fixture was blocked.');
  };
  // This guards the real adapter, not a replacement for it. A regression must not
  // accidentally contact the host's real player (including the UI's default port).
  for (const transport of [http, https]) {
    for (const name of ['request', 'get']) {
      const original = transport[name];
      originals.push(() => { transport[name] = original; });
      transport[name] = function (...args) {
        let options;
        try {
          options = typeof args[0] === 'string' || args[0] instanceof URL
            ? { ...urlToHttpOptions(new URL(args[0])), ...(typeof args[1] === 'object' ? args[1] : {}) }
            : args[0];
          if (transport !== http || !options || (options.protocol ?? 'http:') !== 'http:'
            || (options.hostname ?? options.host) !== '127.0.0.1'
            || Number(options.port) !== port || (options.method ?? 'GET') !== 'GET'
            || !ALLOWED_UPSTREAM_PATHS.has(options.path)) reject();
        } catch {
          reject();
        }
        return Reflect.apply(original, this, args);
      };
    }
  }
  // The current adapter uses node:http; deny alternate fetch-based egress too.
  globalThis.fetch = async () => reject();
  syncBuiltinESMExports();
  return {
    wasBlocked: () => blocked,
    restore() {
      for (const restore of originals) restore();
      globalThis.fetch = originalFetch;
      syncBuiltinESMExports();
    },
  };
}

async function launchFirefox(executable, resources, signal) {
  resources.profile = await mkdtemp(join(tmpdir(), 'mobmentality-firefox-smoke-'));
  const preferences = {
    'browser.startup.page': 0,
    'browser.startup.homepage': 'about:blank',
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.aboutwelcome.enabled': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.newtabpage.enabled': false,
    'browser.formfill.enable': false,
    'signon.rememberSignons': false,
    'network.proxy.type': 0,
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'datareporting.healthreport.uploadEnabled': false,
    'toolkit.telemetry.enabled': false,
    'app.update.auto': false,
  };
  await writeFile(join(resources.profile, 'user.js'), Object.entries(preferences)
    .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));

  const child = spawn(executable, [
    '--headless', '--no-remote', '--profile', resources.profile,
    '--remote-debugging-port', '0', 'about:blank',
  ], {
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MOZ_NO_REMOTE: '1',
      MOZ_AUTOMATION: '1',
      MOZ_CRASHREPORTER_DISABLE: '1',
      MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '0',
      MOZ_HEADLESS_WIDTH: '1280',
      MOZ_HEADLESS_HEIGHT: '900',
      MOZ_LOG: '',
      MOZ_LOG_FILE: '',
    },
  });
  resources.browser = child;
  resources.browserExited = new Promise((resolvePromise) => {
    child.once('exit', resolvePromise);
    child.once('error', resolvePromise);
  });
  const endpoint = new Promise((resolvePromise, rejectPromise) => {
    child.once('error', () => rejectPromise(new SmokeFailure('Firefox could not be launched.')));
    child.once('exit', () => rejectPromise(new SmokeFailure('Firefox exited before its BiDi listener was ready.')));
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = '';
      let found = false;
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (found) return;
        buffer = (buffer + chunk).slice(-16_384);
        const match = /WebDriver BiDi listening on (ws:\/\/[^\s]+)[\r\n]/u.exec(buffer);
        if (!match) return;
        found = true;
        buffer = '';
        try {
          const url = new URL(match[1]);
          check(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
            && Number(url.port) > 0 && !url.username && !url.password && !url.search && !url.hash
            && url.pathname === '/', 'Firefox reported an unexpected debugging endpoint.');
          // Firefox advertises the listener origin; session-less BiDi uses /session.
          url.pathname = '/session';
          resolvePromise(url.href);
        } catch {
          rejectPromise(new SmokeFailure('Firefox reported an unexpected debugging endpoint.'));
        }
      });
    }
  });
  return bounded(endpoint, 20_000, 'Firefox did not announce a loopback WebDriver BiDi endpoint in time.', signal);
}

class BiDi {
  constructor(endpoint, signal) {
    this.signal = signal;
    this.nextId = 0;
    this.pending = new Map();
    this.socket = new WebSocket(endpoint);
    this.closed = new Promise((resolvePromise) => this.socket.addEventListener('close', resolvePromise, { once: true }));
    this.opened = new Promise((resolvePromise, rejectPromise) => {
      this.socket.addEventListener('open', resolvePromise, { once: true });
      this.socket.addEventListener('error', () => rejectPromise(new SmokeFailure('Firefox BiDi could not connect.')), { once: true });
      this.socket.addEventListener('close', () => rejectPromise(new SmokeFailure('Firefox BiDi closed before connecting.')), { once: true });
    });
    this.socket.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { this.failPending(); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.type === 'success') pending.resolve(message.result);
      else pending.reject(new SmokeFailure(`Firefox rejected the ${pending.method} command.`));
    });
    this.socket.addEventListener('error', () => this.failPending());
    this.socket.addEventListener('close', () => this.failPending());
  }

  failPending() {
    for (const pending of this.pending.values()) {
      pending.reject(new SmokeFailure('Firefox BiDi disconnected during a command.'));
    }
  }

  async command(method, params = {}, { timeout = COMMAND_TIMEOUT_MS, signal = this.signal } = {}) {
    check(this.socket.readyState === WebSocket.OPEN, 'Firefox BiDi is not connected.');
    signal?.throwIfAborted();
    const id = ++this.nextId;
    const response = new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { method, resolve: resolvePromise, reject: rejectPromise });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    try {
      return await bounded(response, timeout, `Firefox did not finish the ${method} command in time.`, signal);
    } finally {
      this.pending.delete(id);
    }
  }
}

function browserPage(bidi, context, signal) {
  async function evaluate(fn, ...args) {
    const response = await bidi.command('script.evaluate', {
      expression: `Promise.resolve((${fn.toString()})(...${JSON.stringify(args)})).then(value => JSON.stringify(value ?? null))`,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    check(response.type === 'success' && response.result?.type === 'string', 'A browser-side smoke check could not execute.');
    try { return JSON.parse(response.result.value); } catch { throw new SmokeFailure('A browser-side smoke check returned an invalid result.'); }
  }

  async function waitFor(fn, message, ...args) {
    const deadline = performance.now() + 8_000;
    while (performance.now() < deadline) {
      signal.throwIfAborted();
      if (await evaluate(fn, ...args)) return;
      await delay(75, undefined, { signal });
    }
    throw new SmokeFailure(message);
  }

  async function click(id) {
    const point = await evaluate((elementId) => {
      const element = document.getElementById(elementId);
      if (!element || element.matches(':disabled') || !element.checkVisibility()) return null;
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      return { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) };
    }, id);
    check(point !== null, `The ${id} control was not available.`);
    await bidi.command('input.performActions', { context, actions: [{
      type: 'pointer', id: 'smoke-mouse', parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: point.x, y: point.y, origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
      ],
    }] });
  }

  async function connect(address, username, password) {
    await evaluate((values) => {
      for (const [id, value] of Object.entries(values)) {
        const input = document.getElementById(id);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.getElementById('password').focus();
      return true;
    }, { address, username, password });
    // Submit through the keyboard, exercising native form submission and preventDefault.
    await bidi.command('input.performActions', { context, actions: [{
      type: 'key', id: 'smoke-keyboard', actions: [
        { type: 'keyDown', value: '\uE007' },
        { type: 'keyUp', value: '\uE007' },
      ],
    }] });
    check(await evaluate(() => document.getElementById('username').value === ''
      && document.getElementById('password').value === ''), 'Submitting the connection form did not clear its credential fields.');
  }

  async function checkPrivateState() {
    check(await evaluate(async () => {
      if (localStorage.length !== 0 || sessionStorage.length !== 0 || document.cookie !== '') return false;
      if (typeof caches !== 'undefined' && (await caches.keys()).length !== 0) return false;
      if (typeof indexedDB.databases === 'function' && (await indexedDB.databases()).length !== 0) return false;
      return document.getElementById('username').value === '' && document.getElementById('password').value === '';
    }), 'Credentials were not cleared, or the app persisted browser storage.');
    const cookies = await bidi.command('storage.getCookies', { partition: { type: 'context', context } });
    check(cookies.cookies.length === 0, 'The isolated browser context contained persisted cookies.');
  }

  return { evaluate, waitFor, click, connect, checkPrivateState };
}

async function exerciseUi(bidi, appOrigin, fixtureOrigin, fixture, observed, signal) {
  const { context } = await bidi.command('browsingContext.create', { type: 'tab' });
  const page = browserPage(bidi, context, signal);
  await bidi.command('browsingContext.navigate', { context, url: `${appOrigin}/`, wait: 'complete' });
  await page.waitFor(() => {
    const button = document.getElementById('connect-button');
    return button && !button.matches(':disabled');
  }, 'The connection form did not become ready.');
  check(await page.evaluate(() => document.getElementById('password').type === 'password'
    && document.getElementById('password').autocomplete === 'off'
    && document.getElementById('username').autocomplete === 'off'
    && document.getElementById('connection-form').method === 'post'), 'The credential form did not use the expected safe controls.');
  await page.checkPrivateState();
  check(observed.api.length === 0 && fixture.requests.length === 0, 'Loading the UI unexpectedly contacted an API.');

  const waitConnected = () => page.waitFor(() => !document.getElementById('connection-details').hidden
    && !document.getElementById('disconnect-button').disabled, 'The connection test did not succeed.');
  const waitAuthError = () => page.waitFor(() => !document.getElementById('error-panel').hidden
    && /rejected.*credentials|credentials.*rejected/iu.test(document.getElementById('error-message').textContent)
    && !document.getElementById('connection-form').hidden
    && !document.getElementById('connect-button').matches(':disabled'), 'Wrong authentication did not reset the connection with a visible error.');
  const connect = (password = fixture.credentials.password) => page.connect(fixtureOrigin, fixture.credentials.username, password);

  await connect();
  await waitConnected();
  await page.checkPrivateState();
  check(await page.evaluate((player) => document.getElementById('player-name').textContent === player.name
    && document.getElementById('player-version').textContent === player.version
    && document.getElementById('plugin-version').textContent === player.pluginVersion, PLAYER), 'Connected player/version details were incorrect.');
  check(await page.evaluate((expected) => {
    const options = [...document.getElementById('playlist-select').options];
    return options.length === expected.length + 1 && expected.every((playlist) => {
      const option = options.find((item) => item.value === playlist.id);
      return option && option.textContent.includes(playlist.title)
        && option.textContent.includes(`${playlist.itemCount} entries`)
        && option.disabled === (playlist.itemCount === 0) && option.childElementCount === 0;
    });
  }, fixture.playlists), 'Playlist labels, entry counts or empty-playlist availability were incorrect.');

  const sourceRequests = observed.api.filter((request) => request.path === '/api/source').length;
  await page.evaluate((id) => {
    const select = document.getElementById('playlist-select');
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, SOURCE_ID);
  await delay(150, undefined, { signal });
  check(observed.api.filter((request) => request.path === '/api/source').length === sourceRequests, 'Changing the dropdown implicitly selected a source.');
  await page.click('select-source-button');
  await page.waitFor((title) => document.getElementById('selected-summary').dataset.state === 'selected'
    && document.getElementById('source-status').textContent.includes(title), 'The explicit source selection was not shown.', HOSTILE_TITLE);
  check(await page.evaluate((title) => {
    const status = document.getElementById('source-status');
    return status.textContent.includes(title) && status.textContent.includes('7 entries')
      && status.childElementCount === 0 && globalThis.__mmSmokeXss !== true
      && document.querySelector('#playlist-select img, #playlist-select script, #selected-summary img, #selected-summary script') === null;
  }, HOSTILE_TITLE), 'A malicious-looking playlist label was not rendered as literal text.');
  await page.checkPrivateState();
  check(fixture.playlists.find((playlist) => playlist.isCurrent)?.id === CURRENT_ID,
    'Selecting the source changed the fake player’s current playlist.');

  fixture.playlists = fixture.playlists.filter((playlist) => playlist.id !== SOURCE_ID)
    .map((playlist, index) => ({ ...playlist, index }));
  await page.click('refresh-button');
  await page.waitFor((removedId) => !document.getElementById('refresh-button').disabled
    && document.getElementById('selected-summary').dataset.state === 'empty'
    && /cleared/iu.test(document.getElementById('source-status').textContent)
    && ![...document.getElementById('playlist-select').options].some((option) => option.value === removedId),
  'Refreshing did not visibly clear the removed source.', SOURCE_ID);
  await page.checkPrivateState();

  async function disconnect() {
    const upstreamCount = fixture.requests.length;
    await page.click('disconnect-button');
    await page.waitFor(() => !document.getElementById('connection-form').hidden
      && !document.getElementById('connect-button').matches(':disabled')
      && /^Disconnected/u.test(document.getElementById('connection-status').textContent), 'Disconnect did not clear the local connection.');
    check(await page.evaluate(() => document.getElementById('playlist-select').options.length === 1
      && document.getElementById('playlist-select').matches(':disabled')
      && document.getElementById('selected-summary').dataset.state === 'empty'
      && document.getElementById('connection-details').hidden), 'Disconnect left player or source data in the UI.');
    await page.checkPrivateState();
    check(fixture.requests.length === upstreamCount, 'Disconnect unexpectedly contacted Beefweb.');
  }

  await disconnect();
  await connect(fixture.wrongPassword);
  await waitAuthError();
  await page.checkPrivateState();
  check(fixture.requests.some((request) => !request.authorized), 'The fake server did not receive the wrong-authentication test.');

  await connect();
  await waitConnected();
  fixture.forceUnauthorized = true;
  await page.click('refresh-button');
  await waitAuthError();
  await page.checkPrivateState();
  check(await page.evaluate(() => document.getElementById('playlist-select').matches(':disabled')
    && document.getElementById('selected-summary').dataset.state === 'empty'), 'An authentication failure left a usable local session.');
  fixture.forceUnauthorized = false;

  await connect();
  await waitConnected();
  await disconnect();
  check(observed.api.every((request) => request.valid), 'An app API request omitted required headers, used an unexpected route, or used the wrong method.');
  check(observed.api.filter((request) => request.path === '/api/source').length === sourceRequests + 1,
    'The UI sent an unexpected number of source-selection requests.');
  check(observed.xssRequests === 0, 'A playlist label triggered an HTML resource request.');
  check(fixture.requests.length > 0 && fixture.requests.every((request) => request.allowed)
    && !fixture.unexpectedBody, 'Upstream requests were not exclusively bodyless GETs to the two metadata endpoints.');
  check(ALLOWED_UPSTREAM_PATHS.size === new Set(fixture.requests.filter((request) => request.authorized).map((request) => request.path)).size,
    'Both read-only Beefweb metadata endpoints were not exercised.');
}

async function stopBrowser(resources) {
  const child = resources.browser;
  const alive = () => child?.pid && child.exitCode === null && child.signalCode === null;
  if (alive() && resources.bidi?.socket.readyState === WebSocket.OPEN) {
    try { await resources.bidi.command('browser.close', {}, { timeout: 3_000, signal: null }); } catch { /* Fall back to the owned process tree. */ }
  }
  if (alive()) {
    try { await bounded(resources.browserExited, 3_000, 'Firefox did not exit.'); } catch {
      if (alive()) {
        if (process.platform === 'win32') {
          // Never kill by executable name: this PID and its descendants are ours.
          await bounded(new Promise((resolvePromise, rejectPromise) => {
            execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 },
              (error) => error && alive() ? rejectPromise(error) : resolvePromise());
          }), 6_000, 'The isolated Firefox process tree could not be stopped.');
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        await bounded(resources.browserExited, 3_000, 'The isolated Firefox process did not exit.');
      }
    }
  }
  if (resources.bidi) {
    resources.bidi.socket.close();
    await bounded(resources.bidi.closed, 2_000, 'The browser debugging connection did not close.');
  }
}

async function cleanup(resources) {
  const failures = [];
  try { await stopBrowser(resources); } catch { failures.push('isolated browser shutdown'); }
  for (const { server, sockets } of resources.servers.toReversed()) {
    try {
      await bounded(new Promise((resolvePromise) => {
        server.close(resolvePromise);
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      }), 3_000, 'A test HTTP server did not close.');
    } catch { failures.push('test server shutdown'); }
  }
  try { resources.network?.restore(); } catch { failures.push('network guard restoration'); }
  if (resources.profile) {
    try {
      await bounded(rm(resources.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
        8_000, 'The temporary profile could not be removed.');
    } catch { failures.push('temporary profile removal'); }
  }
  return failures;
}

async function main() {
  const resources = { servers: [] };
  const controller = new AbortController();
  const signal = controller.signal;
  let phase = 'startup';
  let failure;
  const cancel = () => controller.abort(new SmokeFailure('Interrupted; cleanup requested.'));
  const unexpected = () => controller.abort(new SmokeFailure('Unexpected process error; details suppressed.'));
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  process.on('uncaughtException', unexpected);
  process.on('unhandledRejection', unexpected);
  const deadline = setTimeout(() => controller.abort(new SmokeFailure('The 90-second smoke-check deadline was exceeded.')), SUITE_TIMEOUT_MS);
  try {
    check(Number(process.versions.node.split('.')[0]) >= 24, 'This optional smoke check requires Node 24 or newer.');
    check(process.argv.length === 3, 'Usage: node scripts/browser-smoke.js "<path to Firefox>"');
    const executable = resolve(process.argv[2]);
    check((await stat(executable)).isFile(), 'The supplied Firefox executable was not found.');
    const fixture = makeFixture(resources);
    const fixtureOrigin = await listen(fixture.server, signal);
    resources.network = restrictBackendNetwork(fixtureOrigin);

    phase = 'local app startup';
    const module = await bounded(import(new URL('../src/server.js', import.meta.url)), 10_000,
      'src/server.js must be available and export async createApp() before this check can run.', signal);
    check(typeof module.createApp === 'function', 'src/server.js must export async createApp().');
    const app = trackServer(await bounded(module.createApp(), 10_000, 'createApp() did not finish.', signal), resources);
    check(!app.listening, 'createApp() must return an unbound server for the isolated smoke check.');
    const observed = { api: [], xssRequests: 0 };
    app.on('request', (request) => {
      if (request.url?.startsWith('/smoke-xss')) observed.xssRequests += 1;
      if (!request.url?.startsWith('/api/')) return;
      const known = APP_ROUTES.has(request.url);
      const authenticated = request.url !== '/api/connect';
      observed.api.push({
        path: known ? request.url : 'unexpected',
        valid: known && request.headers['x-mobmentality-client'] === '1'
          && (authenticated ? typeof request.headers['x-mobmentality-session'] === 'string'
            && request.headers['x-mobmentality-session'].length > 0 : request.headers['x-mobmentality-session'] === undefined)
          && request.method === (request.url === '/api/playlists' ? 'GET' : 'POST')
          && (request.method === 'GET' || request.headers['content-type'] === 'application/json'),
      });
    });
    const appOrigin = await listen(app, signal);

    phase = 'Firefox BiDi setup';
    const endpoint = await launchFirefox(executable, resources, signal);
    resources.bidi = new BiDi(endpoint, signal);
    await bounded(resources.bidi.opened, 10_000, 'Firefox BiDi could not connect in time.', signal);
    await resources.bidi.command('session.new', { capabilities: { alwaysMatch: { browserName: 'firefox' } } });
    phase = 'browser UI checks';
    await exerciseUi(resources.bidi, appOrigin, fixtureOrigin, fixture, observed, signal);
    check(!resources.network.wasBlocked(), 'The backend attempted a request outside the read-only fixture.');
  } catch (error) {
    failure = resources.network?.wasBlocked()
      ? 'An outbound request outside the read-only fixture was blocked.'
      : error instanceof SmokeFailure ? error.message : `Unexpected failure during ${phase}; details suppressed.`;
  } finally {
    clearTimeout(deadline);
    controller.abort(new SmokeFailure('Smoke check finished.'));
    const cleanupFailures = await cleanup(resources);
    if (cleanupFailures.length) failure = `${failure ? `${failure} ` : ''}Cleanup incomplete: ${cleanupFailures.join(', ')}.`;
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    process.removeListener('uncaughtException', unexpected);
    process.removeListener('unhandledRejection', unexpected);
  }
  const exitCode = failure ? 1 : 0;
  const message = failure
    ? `FAIL: Firefox browser smoke — ${failure}\n`
    : 'PASS: Firefox browser smoke — connect, source selection, refresh removal, auth failures, disconnect, literal labels, private storage and read-only upstream requests.\n';
  // Cleanup is complete; do not let an unexpected timer in the imported app hang this optional command.
  await new Promise((resolvePromise) => (failure ? process.stderr : process.stdout).write(message, resolvePromise));
  process.exit(exitCode);
}

await main();
