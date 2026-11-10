const ui = Object.fromEntries(
  [
    "connection-form", "connection-fields", "address", "username", "password",
    "connect-button", "connection-indicator", "connection-status", "connection-details",
    "player-name", "player-version", "plugin-version", "connected-address",
    "disconnect-button", "source-form", "source-fields", "playlist-select",
    "playlist-summary", "select-source-button", "refresh-button", "selected-summary",
    "source-status", "error-panel", "error-message", "disconnect-recovery", "clear-local-button",
  ].map((id) => [id, document.getElementById(id)]),
);

// This module is the only browser-side session store. Nothing is restored on load.
const state = {
  sessionToken: null,
  playlists: [],
  selectedPlaylist: null,
  operation: null,
  selectionUncertain: false,
  disconnectUnconfirmed: false,
};
const numberFormat = new Intl.NumberFormat();
const requestTimeoutMs = 30_000;

class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse() {
  return new ApiError("INVALID_RESPONSE", "The local service returned an unexpected response. No result could be confirmed.");
}

async function request(path, { method = "GET", body, authenticated = true } = {}) {
  const headers = { Accept: "application/json", "X-MobMentality-Client": "1" };
  if (authenticated) {
    if (!state.sessionToken) {
      throw new ApiError("SESSION_EXPIRED", "There is no session in this tab. Connect again to continue.");
    }
    headers["X-MobMentality-Session"] = state.sessionToken;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    let response;
    try {
      // Only fixed, same-origin paths reach this helper; redirects must not forward secrets.
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        mode: "same-origin",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        // Firefox otherwise strips the POST Origin needed by the local CSRF check.
        referrerPolicy: "same-origin",
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new ApiError("CLIENT_TIMEOUT", "The local service did not finish within 30 seconds. The request was not retried.");
      }
      throw new ApiError("LOCAL_SERVICE_UNREACHABLE", "This tab could not reach the local MobMentality service. Check that it is running, then try again when ready.");
    }

    let data;
    try {
      data = await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw new ApiError("CLIENT_TIMEOUT", "The local service did not finish within 30 seconds. The request was not retried.");
      }
      throw invalidResponse();
    }
    if (!response.ok) {
      const error = isRecord(data?.error) ? data.error : {};
      throw new ApiError(
        typeof error.code === "string" ? error.code : "HTTP_ERROR",
        typeof error.message === "string" && error.message.trim()
          ? error.message
          : `The local service returned HTTP ${response.status}.`,
        response.status,
      );
    }
    if (!isRecord(data)) throw invalidResponse();
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}

function readPlaylist(value) {
  if (
    !isRecord(value)
    || !((typeof value.id === "string" && value.id.length > 0) || Number.isSafeInteger(value.id))
    || typeof value.title !== "string"
    || !Number.isSafeInteger(value.itemCount)
    || value.itemCount < 0
  ) {
    throw invalidResponse();
  }
  return { id: value.id, title: value.title, itemCount: value.itemCount };
}

function readPlaylists(value) {
  if (!Array.isArray(value)) throw invalidResponse();
  const playlists = value.map(readPlaylist);
  if (new Set(playlists.map((playlist) => String(playlist.id))).size !== playlists.length) {
    throw invalidResponse();
  }
  return playlists;
}

function readSelected(value, playlists) {
  if (value === null) return null;
  const selected = readPlaylist(value);
  const match = playlists.find((playlist) => String(playlist.id) === String(selected.id));
  if (!match || match.itemCount === 0) throw invalidResponse();
  return match;
}

function playlistTitle(playlist) {
  return playlist.title.trim() ? playlist.title : "Untitled playlist";
}

function entryCount(count) {
  return `${numberFormat.format(count)} ${count === 1 ? "entry" : "entries"}`;
}

function candidatePlaylist() {
  return state.playlists.find((playlist) => String(playlist.id) === ui["playlist-select"].value);
}

function clearCredentialFields() {
  ui.username.value = "";
  ui.password.value = "";
}

function connectionStatus(message, kind) {
  ui["connection-status"].textContent = message;
  ui["connection-indicator"].dataset.state = kind;
}

function updateControls() {
  const connected = state.sessionToken !== null;
  const busy = state.operation !== null;
  const candidate = candidatePlaylist();
  const sourceLocked = busy || !connected || state.disconnectUnconfirmed;

  ui["connection-form"].hidden = connected;
  ui["connection-details"].hidden = !connected;
  ui["connection-fields"].disabled = busy || connected;
  ui["connect-button"].disabled = busy || connected;
  ui["disconnect-button"].disabled = busy || !connected;
  ui["source-fields"].disabled = sourceLocked;
  ui["playlist-select"].disabled = sourceLocked || state.playlists.length === 0;
  ui["select-source-button"].disabled = sourceLocked
    || state.selectionUncertain
    || !candidate
    || candidate.itemCount === 0
    || (state.selectedPlaylist !== null && String(candidate.id) === String(state.selectedPlaylist.id));
  ui["refresh-button"].disabled = sourceLocked;
  ui["clear-local-button"].disabled = busy || !connected;
  ui["disconnect-recovery"].hidden = !connected || !state.disconnectUnconfirmed;

  ui["connect-button"].textContent = state.operation === "connect" ? "Testing connection…" : "Test connection";
  ui["select-source-button"].textContent = state.operation === "source" ? "Selecting source…" : "Select source";
  ui["refresh-button"].textContent = state.operation === "refresh" ? "Refreshing…" : "Refresh playlists";
  ui["disconnect-button"].textContent = state.operation === "disconnect" ? "Disconnecting…" : "Disconnect";
  ui["connection-form"].setAttribute("aria-busy", String(state.operation === "connect"));
  ui["source-form"].setAttribute("aria-busy", String(state.operation === "source" || state.operation === "refresh"));
  ui["connection-details"].setAttribute("aria-busy", String(state.operation === "disconnect"));
}

function renderPlaylists(preferredId = "") {
  const connected = state.sessionToken !== null;
  const usableCount = state.playlists.filter((playlist) => playlist.itemCount > 0).length;
  const fragment = document.createDocumentFragment();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.textContent = !connected ? "Connect to load playlists"
    : state.playlists.length === 0 ? "No playlists available"
      : usableCount === 0 ? "No usable playlists" : "Choose a source playlist";
  fragment.append(placeholder);

  for (const playlist of state.playlists) {
    const option = document.createElement("option");
    option.value = String(playlist.id);
    option.textContent = `${playlistTitle(playlist)} — ${entryCount(playlist.itemCount)}${playlist.itemCount === 0 ? " (empty; unavailable)" : ""}`;
    option.disabled = playlist.itemCount === 0;
    fragment.append(option);
  }
  ui["playlist-select"].replaceChildren(fragment);
  const preferred = state.playlists.find((playlist) => String(playlist.id) === String(preferredId) && playlist.itemCount > 0);
  ui["playlist-select"].value = preferred ? String(preferred.id) : "";

  ui["playlist-summary"].textContent = !connected
    ? "Connect to see a read-only snapshot of your playlists."
    : state.playlists.length === 0
      ? "No playlists were returned. Add a playlist in foobar2000, then refresh here."
      : usableCount === 0
        ? `All ${numberFormat.format(state.playlists.length)} ${state.playlists.length === 1 ? "playlist is" : "playlists are"} empty. Add entries in foobar2000, then refresh here.`
        : `${numberFormat.format(state.playlists.length)} ${state.playlists.length === 1 ? "playlist" : "playlists"} available · ${numberFormat.format(usableCount)} usable. Counts are playlist entries, not unique songs.`;
  updateControls();
}

function renderSource(prefix = "") {
  const selected = state.selectedPlaylist;
  ui["selected-summary"].dataset.state = selected ? "selected" : "empty";
  ui["source-status"].textContent = prefix + (selected
    ? `Selected source: “${playlistTitle(selected)}” — ${entryCount(selected.itemCount)}. This choice is kept in app memory only.`
    : !state.sessionToken
      ? "No source selected. Connect to load your playlists."
      : state.playlists.some((playlist) => playlist.itemCount > 0)
        ? "No source selected. Choose a playlist above, then use Select source."
        : "No usable source yet. A playlist needs at least one entry before you can select it.");
}

function resetLocalConnection() {
  state.sessionToken = null;
  state.playlists = [];
  state.selectedPlaylist = null;
  state.selectionUncertain = false;
  state.disconnectUnconfirmed = false;
  ui["connection-form"].reset();
  ui.address.setCustomValidity("");
  clearCredentialFields();
  ui["player-name"].textContent = "Not connected";
  ui["player-version"].textContent = "—";
  ui["plugin-version"].textContent = "—";
  ui["connected-address"].textContent = "—";
  renderPlaylists();
  renderSource();
}

function clearError() {
  ui["error-panel"].hidden = true;
  ui["error-message"].textContent = "";
}

function errorDescription(error) {
  const guidanceByCode = {
    SESSION_EXPIRED: "Your session has expired. Re-enter your connection details to continue.",
    BEEFWEB_AUTHENTICATION_FAILED: "Beefweb rejected the credentials. The local connection has been cleared; re-enter your connection details.",
    BEEFWEB_FORBIDDEN: "Beefweb denied read access (403). This is a permission refusal, not a rejected-password response. Verify the endpoint’s access policy before trying again.",
    BEEFWEB_TIMEOUT: "Beefweb did not respond in time. Check the endpoint before trying again.",
    BEEFWEB_UNREACHABLE: "The local service could not reach Beefweb. Check its address and availability before trying again.",
  };
  const guidance = Object.hasOwn(guidanceByCode, error.code) ? guidanceByCode[error.code] : "";
  return guidance ? `${guidance} ${error.message}` : error.status === 504
    ? `The request timed out. ${error.message}` : error.message;
}

function handleFailure(cause, operation) {
  const error = cause instanceof ApiError ? cause : invalidResponse();
  let message = errorDescription(error);
  if (error.code === "SESSION_EXPIRED" || error.code === "BEEFWEB_AUTHENTICATION_FAILED") {
    resetLocalConnection();
    connectionStatus("Not connected. Re-enter your connection details to continue.", "attention");
  } else if (operation === "connect") {
    connectionStatus("Not connected. The connection test did not succeed.", "attention");
    message += " If the service created a session before the failure, that unconfirmed session will expire after 30 minutes of inactivity.";
  } else {
    state.selectionUncertain = true;
    ui["selected-summary"].dataset.state = "uncertain";
    if (operation === "disconnect") {
      state.disconnectUnconfirmed = true;
      connectionStatus("Disconnect not confirmed. Retry Disconnect or clear this tab only.", "attention");
      ui["source-status"].textContent = "Disconnection was not confirmed. The previous source choice is no longer verified; resolve the disconnect before making another choice.";
    } else {
      connectionStatus("Session retained locally; the latest request could not be verified.", "attention");
      ui["source-status"].textContent = "The current source selection could not be confirmed. Refresh playlists to check the app’s selection before choosing a source again.";
    }
  }
  ui["error-panel"].hidden = false;
  ui["error-message"].textContent = message;
}

async function runOperation(operation, task) {
  if (state.operation !== null) return;
  state.operation = operation;
  clearError();
  const progress = {
    connect: "Testing read-only access to Beefweb…",
    source: "Selecting a source in app memory only…",
    refresh: "Refreshing playlists and checking the current source…",
    disconnect: "Asking the local service to clear this session…",
  };
  connectionStatus(progress[operation], "busy");
  updateControls();
  let focusTarget;
  try {
    focusTarget = await task();
  } catch (error) {
    handleFailure(error, operation);
    focusTarget = ui["error-message"];
  } finally {
    state.operation = null;
    updateControls();
    focusTarget?.focus();
  }
}

ui.address.addEventListener("input", () => ui.address.setCustomValidity(""));
ui["connection-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.operation !== null || state.sessionToken) return;

  ui.address.setCustomValidity("");
  try {
    const address = new URL(ui.address.value.trim());
    if (!["http:", "https:"].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
      ui.address.setCustomValidity("Use an HTTP or HTTPS base address without embedded credentials, query parameters or a fragment.");
    }
  } catch {
    ui.address.setCustomValidity("Enter a complete Beefweb address, starting with http:// or https://.");
  }
  if (!ui["connection-form"].reportValidity()) return;

  const credentials = { address: ui.address.value.trim(), username: ui.username.value, password: ui.password.value };
  clearCredentialFields();
  void runOperation("connect", async () => {
    const pending = request("/api/connect", { method: "POST", body: credentials, authenticated: false });
    // request() serializes synchronously, so do not retain a second credential copy while awaiting it.
    credentials.username = "";
    credentials.password = "";
    const data = await pending;
    const playlists = readPlaylists(data.playlists);
    if (
      typeof data.sessionToken !== "string" || !data.sessionToken
      || !isRecord(data.connection) || typeof data.connection.address !== "string"
      || !isRecord(data.connection.player) || data.selectedPlaylist !== null
    ) {
      throw invalidResponse();
    }
    state.sessionToken = data.sessionToken;
    state.playlists = playlists;
    state.selectedPlaylist = null;
    state.selectionUncertain = false;
    state.disconnectUnconfirmed = false;
    const player = data.connection.player;
    const label = (value) => typeof value === "string" && value.trim() ? value : "Not reported";
    ui["player-name"].textContent = label(player.name);
    ui["player-version"].textContent = label(player.version);
    ui["plugin-version"].textContent = label(player.pluginVersion);
    ui["connected-address"].textContent = data.connection.address;
    renderPlaylists();
    renderSource();
    connectionStatus("Connected. Read-only access verified; foobar2000 is unchanged.", "connected");
    return playlists.some((playlist) => playlist.itemCount > 0) ? ui["playlist-select"] : ui["source-status"];
  });
});

ui["playlist-select"].addEventListener("change", updateControls);
ui["source-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  const candidate = candidatePlaylist();
  if (
    state.operation !== null || !state.sessionToken || state.selectionUncertain || state.disconnectUnconfirmed
    || !candidate || candidate.itemCount === 0
    || (state.selectedPlaylist !== null && String(candidate.id) === String(state.selectedPlaylist.id))
  ) return;

  void runOperation("source", async () => {
    const data = await request("/api/source", { method: "POST", body: { playlistId: candidate.id } });
    const selected = readPlaylist(data.selectedPlaylist);
    if (selected.itemCount === 0 || String(selected.id) !== String(candidate.id)) throw invalidResponse();
    state.selectedPlaylist = selected;
    state.playlists = state.playlists.map((playlist) => String(playlist.id) === String(selected.id) ? selected : playlist);
    renderPlaylists(selected.id);
    renderSource();
    connectionStatus("Connected. Source selected in app memory only; foobar2000 is unchanged.", "connected");
    return ui["source-status"];
  });
});

ui["refresh-button"].addEventListener("click", () => {
  if (state.operation !== null || !state.sessionToken || state.disconnectUnconfirmed) return;
  const draftId = ui["playlist-select"].value;
  void runOperation("refresh", async () => {
    const data = await request("/api/playlists");
    const playlists = readPlaylists(data.playlists);
    const selected = readSelected(data.selectedPlaylist, playlists);
    if (typeof data.selectionCleared !== "boolean" || (data.selectionCleared && selected !== null)) throw invalidResponse();
    const cleared = data.selectionCleared || (state.selectedPlaylist !== null && selected === null);
    state.playlists = playlists;
    state.selectedPlaylist = selected;
    state.selectionUncertain = false;
    renderPlaylists(draftId);
    renderSource();
    if (cleared) {
      ui["source-status"].textContent = "Refresh cleared the previous source selection because it is no longer usable. No source is selected. Choose another non-empty playlist when available.";
    }
    connectionStatus("Connected. Playlists refreshed; foobar2000 is unchanged.", "connected");
    return ui["refresh-button"];
  });
});

ui["disconnect-button"].addEventListener("click", () => {
  if (state.operation !== null || !state.sessionToken) return;
  void runOperation("disconnect", async () => {
    const data = await request("/api/disconnect", { method: "POST", body: {} });
    if (data.disconnected !== true) throw invalidResponse();
    resetLocalConnection();
    connectionStatus("Disconnected. The local service confirmed that it cleared this session and its credentials.", "disconnected");
    return ui.address;
  });
});

ui["clear-local-button"].addEventListener("click", () => {
  if (state.operation !== null || !state.disconnectUnconfirmed) return;
  resetLocalConnection();
  clearError();
  connectionStatus("Cleared this tab only. Deletion on the service was not confirmed; an abandoned session expires after 30 minutes of inactivity.", "attention");
  ui.address.focus();
});

// Clear any form values restored by browser history, including a back/forward cache return.
window.addEventListener("pageshow", clearCredentialFields);
resetLocalConnection();
