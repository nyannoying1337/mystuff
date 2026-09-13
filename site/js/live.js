// The live connection: one WebSocket per viewer. The Worker pushes every status
// and frame as the agent sends them, so an open tab costs one request instead
// of polling. map/live-feed.js does the same for the BlueMap page.
import { API_URL } from "./config.js";

const FALLBACK_POLL_MS = 60000;  // only if WebSockets keep failing
const HIDDEN_GRACE_MS = 60000;   // a background tab gives its viewer slot back after this
const KEY_STORAGE = "mc-status-invite";  // shared with map/live-feed.js

// ---- invite key ------------------------------------------------------------------

// Arrives typed into the join form, or as <site>/#key=… (a fragment never
// reaches GitHub). Remembered on this device and removed from the address bar.
let inviteKey = (() => {
  const match = location.hash.match(/(?:^#|&)key=([^&]+)/);
  if (match) {
    const key = decodeURIComponent(match[1]);
    try { localStorage.setItem(KEY_STORAGE, key); } catch { /* private mode: works for this visit */ }
    history.replaceState(null, "", location.pathname + location.search);
    return key;
  }
  try { return localStorage.getItem(KEY_STORAGE); } catch { return null; }
})();

export const hasKey = () => Boolean(inviteKey);

export function rememberKey(key) {
  inviteKey = key;
  try { localStorage.setItem(KEY_STORAGE, key); } catch { /* private mode */ }
}

export function forgetKey() {
  inviteKey = null;
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* nothing stored */ }
}

// Keyed URLs for images the page loads itself.
export const keyedUrl = (path, stamp) =>
  inviteKey ? `${API_URL}${path}?key=${encodeURIComponent(inviteKey)}&t=${stamp}` : null;

// ---- connection --------------------------------------------------------------------

let handlers = null;
let socket = null;
let closingOnPurpose = false;
let failures = 0;
let retryTimer = null;
let pollTimer = null;
let hiddenTimer = null;
let latestFrame = null;

export const isPolling = () => Boolean(pollTimer);
export const frameUrl = () => latestFrame;

/**
 * handlers: status(data, staleMs), frame(), empty(), join(message),
 * full(max), unreachable()
 */
export function start(on) {
  handlers = on;
  connect();
}

export function connect() {
  clearTimeout(retryTimer);
  if (!inviteKey) {
    handlers.join("");
    return;
  }
  if (socket || document.hidden) return;

  closingOnPurpose = false;
  let fullMax = null;
  const ws = new WebSocket(`${API_URL.replace(/^http/, "ws")}/live?key=${encodeURIComponent(inviteKey)}`);
  ws.binaryType = "blob";
  socket = ws;

  ws.addEventListener("open", () => {
    failures = 0;
    stopPolling();
  });

  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      if (latestFrame) URL.revokeObjectURL(latestFrame);
      latestFrame = URL.createObjectURL(event.data);
      handlers.frame();
      return;
    }
    const message = JSON.parse(event.data);
    if (message.type === "status") handlers.status(message.status, message.stale_ms);
    else if (message.type === "empty") handlers.empty();
    else if (message.type === "full") fullMax = message.max;
  });

  ws.addEventListener("close", (event) => {
    if (socket === ws) socket = null;
    if (event.code === 4001) {
      forgetKey();
      handlers.join("That key didn't work. Check it, or ask for a new invite.");
      return;
    }
    if (event.code === 4003) {
      handlers.full(fullMax);
      return;
    }
    if (closingOnPurpose) return;
    failures += 1;
    if (failures >= 3) startPolling();
    else handlers.unreachable();
    retryTimer = setTimeout(connect, Math.min(300000, 2000 * 2 ** (failures - 1)));
  });
}

export function disconnect() {
  closingOnPurpose = true;
  clearTimeout(retryTimer);
  if (socket) socket.close(1000, "closing");
  socket = null;
  stopPolling();
}

// Fallback for networks that block WebSockets: a keyed poll once a minute.
async function poll() {
  if (document.hidden || !inviteKey) return;
  try {
    const response = await fetch(`${API_URL}/status?key=${encodeURIComponent(inviteKey)}`, { cache: "no-store" });
    if (response.status === 401) {
      forgetKey();
      handlers.join("That key didn't work. Check it, or ask for a new invite.");
    } else if (response.status === 404) {
      handlers.empty();
    } else {
      handlers.status(await response.json());
    }
  } catch {
    handlers.unreachable();
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(poll, FALLBACK_POLL_MS);
  poll();
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenTimer = setTimeout(disconnect, HIDDEN_GRACE_MS);
  } else {
    clearTimeout(hiddenTimer);
    if (inviteKey && handlers) connect();
  }
});

// keep-alive, answered by Cloudflare without waking anything (and not billed)
setInterval(() => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send("ping");
}, 45000);
