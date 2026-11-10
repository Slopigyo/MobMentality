import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PLAYLISTS = 10_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const ERRORS = Object.freeze({
  INVALID_ADDRESS: [400, 'Use a loopback or private LAN HTTP or HTTPS address.'],
  INVALID_CREDENTIALS: [400, 'Supply a valid Beefweb username and password.'],
  BEEFWEB_AUTHENTICATION_FAILED: [401, 'Beefweb rejected the credentials.'],
  BEEFWEB_FORBIDDEN: [403, 'Beefweb denied access.'],
  CONNECTION_CLOSED: [409, 'The Beefweb connection is closed.'],
  BEEFWEB_TIMEOUT: [504, 'Beefweb did not respond in time.'],
  BEEFWEB_UNREACHABLE: [502, 'Unable to reach Beefweb securely.'],
  BEEFWEB_INVALID_RESPONSE: [502, 'Beefweb returned an invalid response.'],
  BEEFWEB_REDIRECT: [502, 'Beefweb redirects are not allowed.'],
  BEEFWEB_ERROR: [502, 'The Beefweb request failed.'],
});

export class BeefwebError extends Error {
  constructor(code = 'BEEFWEB_ERROR') {
    const safeCode = typeof code === 'string' && Object.hasOwn(ERRORS, code)
      ? code
      : 'BEEFWEB_ERROR';
    const [status, message] = ERRORS[safeCode];
    super(message);
    this.name = 'BeefwebError';
    this.status = status;
    this.code = safeCode;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAllowedIp(address) {
  const family = isIP(address);
  if (family === 4) {
    const [first, second] = address.split('.').map(Number);
    return first === 127 || first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (family === 6 && !address.includes('%') && !address.includes('.')) {
    const normalized = new URL(`http://[${address}]`).hostname;
    // Only IPv6 loopback and ULA; mapped IPv4, scoped and transition addresses fail closed.
    return normalized === '[::1]' || /^\[f[cd][0-9a-f]{2}:/u.test(normalized);
  }
  return false;
}

function parseAddress(address) {
  // Check the original spelling before URL can discard userinfo or normalize dot segments.
  if (typeof address !== 'string' || address.length > 2048
    || /[\s\u0000-\u001f\u007f-\u009f\\@%?#]/u.test(address)
    || !/^https?:\/\/[^/]+(?:\/(?:api\/?)?)?$/iu.test(address)) {
    throw new BeefwebError('INVALID_ADDRESS');
  }

  let url;
  try {
    url = new URL(address);
  } catch {
    throw new BeefwebError('INVALID_ADDRESS');
  }
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (!hostname || url.username || url.password || url.search || url.hash || url.port === '0'
    || !['/', '/api', '/api/'].includes(url.pathname)) {
    throw new BeefwebError('INVALID_ADDRESS');
  }
  if (isIP(hostname)) {
    if (!isAllowedIp(hostname)) throw new BeefwebError('INVALID_ADDRESS');
  } else {
    const labels = hostname.replace(/\.$/u, '').split('.');
    if (hostname.length > 253 || labels.some((label) =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))) {
      throw new BeefwebError('INVALID_ADDRESS');
    }
  }
  return { address: url.origin, hostname, protocol: url.protocol, port: url.port };
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || username.length === 0 || username.length > 256
    || username.includes(':') || CONTROL_CHARACTERS.test(username)
    || typeof password !== 'string' || password.length === 0 || password.length > 1024) {
    throw new BeefwebError('INVALID_CREDENTIALS');
  }
}

function networkError(error) {
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ETIMEOUT') {
    return new BeefwebError('BEEFWEB_TIMEOUT');
  }
  if (typeof error?.code === 'string' && error.code.startsWith('HPE_')) {
    return new BeefwebError('BEEFWEB_INVALID_RESPONSE');
  }
  return new BeefwebError('BEEFWEB_UNREACHABLE');
}

async function resolveAddress(hostname, timeoutMs) {
  const family = isIP(hostname);
  if (family) return { address: hostname, family };

  const addresses = await new Promise((resolve, reject) => {
    let settled = false;
    const deadline = performance.now() + timeoutMs;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new BeefwebError('BEEFWEB_TIMEOUT')), timeoutMs);
    try {
      dns.lookup(hostname, { all: true, verbatim: true }, (error, result) => {
        if (performance.now() >= deadline) finish(new BeefwebError('BEEFWEB_TIMEOUT'));
        else if (error) finish(networkError(error));
        else finish(null, result);
      });
    } catch (error) {
      finish(networkError(error));
    }
  });

  if (!Array.isArray(addresses) || addresses.length === 0
    || addresses.some((entry) => !isRecord(entry) || typeof entry.address !== 'string'
      || !isAllowedIp(entry.address) || entry.family !== isIP(entry.address))) {
    throw new BeefwebError('INVALID_ADDRESS');
  }
  // Prefer IPv4 (notably when localhost also resolves to ::1); never retry another address.
  const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  return { address: chosen.address, family: chosen.family };
}

function validString(value, maxLength, allowEmpty = false) {
  return typeof value === 'string' && value.length <= maxLength
    && (allowEmpty || value.trim().length > 0) && !CONTROL_CHARACTERS.test(value);
}

function invalidResponse() {
  throw new BeefwebError('BEEFWEB_INVALID_RESPONSE');
}

function readPlayer(payload) {
  if (!isRecord(payload) || !isRecord(payload.player) || !isRecord(payload.player.info)) {
    invalidResponse();
  }
  const { name, version, pluginVersion } = payload.player.info;
  // Validate the v0.10 shape, not an exact version: newer compatible plugins are allowed.
  if (name !== 'foobar2000' || !validString(version, 128) || !validString(pluginVersion, 128)) {
    invalidResponse();
  }
  return { name, version, pluginVersion };
}

function readPlaylists(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.playlists)
    || payload.playlists.length > MAX_PLAYLISTS) {
    invalidResponse();
  }
  const ids = new Set();
  return payload.playlists.map((playlist) => {
    if (!isRecord(playlist)) invalidResponse();
    const { id, index, title, itemCount, totalTime, isCurrent } = playlist;
    if (!validString(id, 256) || !validString(title, 4096, true)
      || !Number.isSafeInteger(index) || index < 0 || typeof isCurrent !== 'boolean'
      || !Number.isSafeInteger(itemCount) || itemCount < 0
      || !Number.isFinite(totalTime) || totalTime < 0 || ids.has(id)) {
      invalidResponse();
    }
    ids.add(id);
    return { id, title, itemCount, totalTime };
  });
}

function makeClient(target, pinned, authorization, timeoutMs) {
  const transport = target.protocol === 'https:' ? https : http;
  // A private agent bypasses both environment proxies and the process-wide global agent.
  const agent = new transport.Agent({ keepAlive: false, proxyEnv: {} });
  const pending = new Set();
  let closed = false;

  function get(path, project) {
    if (closed) return Promise.reject(new BeefwebError('CONNECTION_CLOSED'));
    return new Promise((resolve, reject) => {
      let request;
      let response;
      let settled = false;
      let bytes = 0;
      const chunks = [];
      const deadline = performance.now() + timeoutMs;
      const cancel = () => finish(new BeefwebError('CONNECTION_CLOSED'));
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        chunks.length = 0;
        if (error) {
          response?.destroy();
          request?.destroy();
          reject(error);
        } else {
          resolve(value);
        }
      };
      const expired = () => {
        if (performance.now() < deadline) return false;
        finish(new BeefwebError('BEEFWEB_TIMEOUT'));
        return true;
      };
      // This is a total deadline, not a socket inactivity timeout that streaming can reset.
      const timer = setTimeout(() => finish(new BeefwebError('BEEFWEB_TIMEOUT')), timeoutMs);
      pending.add(cancel);

      try {
        request = transport.request({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          method: 'GET',
          path,
          agent,
          family: pinned.family,
          autoSelectFamily: false,
          lookup(_hostname, options, callback) {
            if (options.all) callback(null, [{ ...pinned }]);
            else callback(null, pinned.address, pinned.family);
          },
          // Preserve the original hostname for Host, SNI and certificate identity checks.
          rejectUnauthorized: true,
          headers: { Accept: 'application/json', Authorization: authorization },
        }, (incoming) => {
          response = incoming;
          response.on('error', () => finish(new BeefwebError('BEEFWEB_INVALID_RESPONSE')));
          response.on('aborted', () => finish(new BeefwebError('BEEFWEB_INVALID_RESPONSE')));
          if (settled) {
            response.destroy();
            return;
          }
          if (expired()) return;
          const status = response.statusCode;
          if (status === 401 || status === 403) {
            finish(new BeefwebError(status === 401 ? 'BEEFWEB_AUTHENTICATION_FAILED' : 'BEEFWEB_FORBIDDEN'));
            return;
          }
          if (status >= 300 && status < 400) {
            finish(new BeefwebError('BEEFWEB_REDIRECT'));
            return;
          }
          if (status !== 200) {
            finish(new BeefwebError('BEEFWEB_ERROR'));
            return;
          }
          const length = response.headers['content-length'];
          const encoding = response.headers['content-encoding'];
          if ((length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES))
            || (encoding !== undefined && encoding.toLowerCase() !== 'identity')) {
            finish(new BeefwebError('BEEFWEB_INVALID_RESPONSE'));
            return;
          }

          response.on('data', (chunk) => {
            if (settled || expired()) return;
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) {
              finish(new BeefwebError('BEEFWEB_INVALID_RESPONSE'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled || expired()) return;
            if (!response.complete) {
              finish(new BeefwebError('BEEFWEB_INVALID_RESPONSE'));
              return;
            }
            let value;
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
              value = project(JSON.parse(text));
            } catch {
              finish(new BeefwebError('BEEFWEB_INVALID_RESPONSE'));
              return;
            }
            if (!expired()) finish(null, value);
          });
        });
        request.on('error', (error) => finish(networkError(error)));
        request.on('upgrade', (_incoming, socket) => {
          socket.destroy();
          finish(new BeefwebError('BEEFWEB_ERROR'));
        });
        request.end();
      } catch {
        finish(new BeefwebError('BEEFWEB_ERROR'));
      }
    });
  }

  return Object.freeze({
    address: target.address,
    getPlayer() {
      return get('/api/player', readPlayer);
    },
    getPlaylists() {
      return get('/api/playlists', readPlaylists);
    },
    dispose() {
      if (closed) return;
      closed = true;
      authorization = undefined;
      for (const cancel of pending) cancel();
      agent.destroy();
    },
  });
}

export async function createBeefwebClient(options = {}) {
  if (!isRecord(options)) throw new BeefwebError('INVALID_ADDRESS');
  let { address, username, password, timeoutMs = 5000 } = options;
  options = undefined;
  const target = parseAddress(address);
  validateCredentials(username, password);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new BeefwebError('BEEFWEB_ERROR');
  }
  const pinned = await resolveAddress(target.hostname, timeoutMs);
  const bytes = Buffer.from(`${username}:${password}`, 'utf8');
  const authorization = `Basic ${bytes.toString('base64')}`;
  bytes.fill(0);
  address = username = password = undefined;
  return makeClient(target, pinned, authorization, timeoutMs);
}
