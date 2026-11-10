import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { BeefwebError, createBeefwebClient } from './beefweb.js';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const BODY_LIMIT = 8192;
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, value) {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function expiredSession() {
  return new AppError(401, 'SESSION_EXPIRED', 'This app session has ended. Connect again.');
}

function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    request.resume();
    throw new AppError(415, 'INVALID_REQUEST', 'Send a JSON request.');
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('aborted', onAborted);
      request.removeListener('error', onAborted);
      chunks.length = 0;
      if (error) {
        request.resume();
        reject(error);
      } else resolve(value);
    };
    const onAborted = () => finish(new AppError(400, 'INVALID_REQUEST', 'The request was interrupted.'));
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) {
        finish(new AppError(413, 'INVALID_REQUEST', 'The request is too large.'));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        finish(null, value);
      } catch {
        finish(new AppError(400, 'INVALID_REQUEST', 'Send a valid JSON object.'));
      }
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onAborted);
  });
}

export async function createApp({
  createClient = createBeefwebClient,
  sessionTtlMs = IDLE_TIMEOUT_MS,
  maxSessions = 16,
  now = Date.now,
} = {}) {
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ].map(async ([route, file, type]) => [route, {
    body: await readFile(new URL(`../web/${file}`, import.meta.url)), type,
  }])));
  const sessions = new Map();
  let connecting = 0;

  function forget(token) {
    const session = sessions.get(token);
    if (!session) return;
    sessions.delete(token);
    session.client.dispose();
    session.playlists = [];
    session.selectedPlaylist = null;
  }

  function sweep() {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now()) forget(token);
    }
  }

  function sessionFor(request) {
    const token = request.headers['x-mobmentality-session'];
    const session = typeof token === 'string' ? sessions.get(token) : undefined;
    // Reading a POST body can cross the idle deadline after the request-level sweep.
    if (!session || session.expiresAt <= now()) {
      forget(token);
      throw expiredSession();
    }
    session.expiresAt = now() + sessionTtlMs;
    return { token, session };
  }

  async function withSession(request, action) {
    const { token, session } = sessionFor(request);
    if (session.busy) throw new AppError(409, 'REQUEST_IN_PROGRESS', 'Wait for the current request to finish.');
    session.busy = true;
    try {
      const result = await action(session);
      // A disconnect or idle expiry during an upstream read must not revive the session.
      if (sessions.get(token) !== session || session.expiresAt <= now()) {
        forget(token);
        throw expiredSession();
      }
      return result;
    } catch (error) {
      if (error instanceof BeefwebError && error.code === 'BEEFWEB_AUTHENTICATION_FAILED') forget(token);
      if (sessions.get(token) !== session && error.code !== 'BEEFWEB_AUTHENTICATION_FAILED') throw expiredSession();
      throw error;
    } finally {
      session.busy = false;
    }
  }

  async function updatePlaylists(session) {
    const playlists = await session.client.getPlaylists();
    const previousId = session.selectedPlaylist?.id;
    const selectedPlaylist = playlists.find((playlist) => playlist.id === previousId && playlist.itemCount > 0) ?? null;
    session.playlists = playlists;
    session.selectedPlaylist = selectedPlaylist;
    return { playlists, selectedPlaylist, selectionCleared: previousId !== undefined && selectedPlaylist === null };
  }

  async function connect(request, response) {
    const credentials = await readJson(request);
    if (sessions.size + connecting >= maxSessions) {
      throw new AppError(429, 'SESSION_LIMIT', 'Too many temporary sessions. Disconnect an existing session or wait for idle expiry.');
    }
    connecting += 1;
    let client;
    let connected = false;
    let abandoned = false;
    const onClose = () => {
      if (!response.writableEnded) {
        abandoned = true;
        client?.dispose();
      }
    };
    response.once('close', onClose);
    try {
      const pending = createClient({
        address: credentials.address,
        username: credentials.username,
        password: credentials.password,
      });
      credentials.username = credentials.password = undefined;
      client = await pending;
      if (abandoned) return;
      const [player, playlists] = await Promise.all([client.getPlayer(), client.getPlaylists()]);
      if (abandoned) return;
      const sessionToken = randomBytes(32).toString('hex');
      sessions.set(sessionToken, {
        client, playlists, selectedPlaylist: null, busy: false, expiresAt: now() + sessionTtlMs,
      });
      connected = true;
      sendJson(response, 200, {
        sessionToken,
        connection: { address: client.address, player },
        playlists,
        selectedPlaylist: null,
        idleTimeoutSeconds: Math.ceil(sessionTtlMs / 1000),
      });
    } finally {
      credentials.username = credentials.password = undefined;
      connecting -= 1;
      response.removeListener('close', onClose);
      if (!connected) client?.dispose();
    }
  }

  const server = http.createServer(async (request, response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    try {
      sweep();
      const origin = `http://127.0.0.1:${server.address().port}`;
      // Exact Host checking prevents a rebinding domain from reading this host-only service.
      if (request.headers.host !== new URL(origin).host
        || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
        throw new AppError(403, 'LOCAL_ACCESS_ONLY', 'Open the host console at its printed loopback address.');
      }
      const route = request.url;
      const asset = assets.get(route);
      if (asset && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': asset.type });
        response.end(asset.body);
        return;
      }
      if (!route?.startsWith('/api/')) throw new AppError(404, 'NOT_FOUND', 'Not found.');
      // A custom header blocks cross-site simple requests; JSON mutations also require Origin.
      if (request.headers['x-mobmentality-client'] !== '1'
        || (request.method !== 'GET' && request.headers.origin !== origin)) {
        throw new AppError(403, 'LOCAL_ACCESS_ONLY', 'Use the local host console for this request.');
      }
      if (route === '/api/connect' && request.method === 'POST') {
        await connect(request, response);
      } else if (route === '/api/playlists' && request.method === 'GET') {
        sendJson(response, 200, await withSession(request, updatePlaylists));
      } else if (route === '/api/source' && request.method === 'POST') {
        const { playlistId } = await readJson(request);
        if (typeof playlistId !== 'string' || playlistId.length === 0 || playlistId.length > 256) {
          throw new AppError(400, 'INVALID_REQUEST', 'Choose a valid playlist.');
        }
        const result = await withSession(request, async (session) => {
          await updatePlaylists(session);
          const selectedPlaylist = session.playlists.find((playlist) => playlist.id === playlistId);
          if (!selectedPlaylist) throw new AppError(409, 'PLAYLIST_MISSING', 'That playlist is no longer available. Refresh the list.');
          if (selectedPlaylist.itemCount === 0) throw new AppError(409, 'EMPTY_PLAYLIST', 'Choose a playlist containing at least one entry.');
          session.selectedPlaylist = selectedPlaylist;
          return { selectedPlaylist };
        });
        sendJson(response, 200, result);
      } else if (route === '/api/disconnect' && request.method === 'POST') {
        await readJson(request);
        forget(request.headers['x-mobmentality-session']);
        sendJson(response, 200, { disconnected: true });
      } else {
        throw new AppError(404, 'NOT_FOUND', 'This read-only endpoint does not exist.');
      }
    } catch (error) {
      const safe = error instanceof AppError || error instanceof BeefwebError
        ? error : new AppError(500, 'INTERNAL_ERROR', 'The local service could not complete the request.');
      sendJson(response, safe.status, { error: { code: safe.code, message: safe.message } });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  const sweeper = setInterval(sweep, Math.min(sessionTtlMs, 60_000));
  sweeper.unref();
  server.once('close', () => {
    clearInterval(sweeper);
    for (const token of sessions.keys()) forget(token);
  });
  return server;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node src/server.js [--port 3210]');
    return;
  }
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/u.test(args[1]))) {
    throw new Error('Use --port followed by a number between 1 and 65535.');
  }
  const port = args.length ? Number(args[1]) : 3210;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port between 1 and 65535.');
  const server = await createApp();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`MobMentality host console: http://127.0.0.1:${port}`);
  console.log('Read-only. Credentials stay in memory. Press Ctrl+C to stop.');
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Unable to start. Check that the port is valid and available; use --help for usage.');
    process.exitCode = 1;
  });
}
