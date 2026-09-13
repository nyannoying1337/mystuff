// PROOF OF CONCEPT: every player on a server, from the server mod.
//
// Two kinds of viewers:
//   admin   ?key=<ADMIN_KEY>                   sees the server and every player
//   player  ?key=<uuid>.<signature>            sees only that player
// Player keys are an HMAC of the player's UUID with PLAYER_LINK_SECRET, so no
// key table is stored: the Worker can check a link without remembering it.
import { DurableObject } from "cloudflare:workers";

const MAX_VIEWERS = 10;
const STALE_MS = 90000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });
}

function safeEqual(given, expected) {
  if (!expected || typeof given !== "string" || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256(text) {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function signature(secret, uuid) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`player:${uuid}`))).slice(0, 32);
}

export async function playerKey(env, uuid) {
  return `${uuid}.${await signature(env.PLAYER_LINK_SECRET, uuid)}`;
}

/** Who a key belongs to: {role: "admin"} | {role: "player", uuid} | null. */
export async function viewerFor(env, key) {
  if (typeof key !== "string" || !key) return null;
  if (safeEqual(key, env.ADMIN_KEY)) return { role: "admin" };
  const [uuid, sig] = key.split(".");
  if (!UUID.test(uuid || "") || !env.PLAYER_LINK_SECRET) return null;
  return safeEqual(sig || "", await signature(env.PLAYER_LINK_SECRET, uuid)) ? { role: "player", uuid } : null;
}

// Changing either secret disconnects everyone who joined before.
const secretsHash = (env) => sha256(`${env.ADMIN_KEY || ""}|${env.PLAYER_LINK_SECRET || ""}`);

/** What one viewer may see of the stored state. */
export function viewFor(viewer, state) {
  const players = state.players || [];
  const visible = viewer.role === "admin" ? players : players.filter((player) => player.uuid === viewer.uuid);
  return {
    type: "server",
    role: viewer.role,
    you: viewer.uuid || null,
    stale_ms: STALE_MS,
    received_at: state.received_at || null,
    server: state.server || null,
    players: visible,
  };
}

function refuseSocket(code, reason) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

export class ServerStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (typeof WebSocketRequestResponsePair !== "undefined") {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  // Each player is its own row, so a big server never hits the 2 MB value limit.
  async state() {
    const rows = await this.ctx.storage.list({ prefix: "server:" });
    const players = [];
    let server = null;
    let receivedAt = null;
    for (const [key, value] of rows) {
      if (key === "server:meta") ({ server, received_at: receivedAt } = JSON.parse(value));
      else if (key.startsWith("server:player:")) players.push(JSON.parse(value));
    }
    players.sort((a, b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name)));
    return { server, received_at: receivedAt, players };
  }

  async publish(payload) {
    const receivedAt = Date.now();
    const incoming = new Map((payload.players || []).filter((p) => UUID.test(p?.uuid || "")).map((p) => [p.uuid, p]));
    const existing = await this.ctx.storage.list({ prefix: "server:player:" });
    const changes = { "server:meta": JSON.stringify({ server: payload.server || null, received_at: receivedAt }) };
    for (const [uuid, player] of incoming) {
      const row = JSON.stringify(player);
      if (existing.get(`server:player:${uuid}`) !== row) changes[`server:player:${uuid}`] = row;  // only changed rows are written
    }
    const gone = [...existing.keys()].filter((key) => !incoming.has(key.slice("server:player:".length)));
    const entries = Object.entries(changes);
    for (let i = 0; i < entries.length; i += 100) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 100)));
    if (gone.length) await this.ctx.storage.delete(gone);

    const state = { server: payload.server || null, received_at: receivedAt, players: [...incoming.values()] };
    const hash = await secretsHash(this.env);
    for (const socket of this.ctx.getWebSockets("server-viewer")) {
      try {
        const viewer = socket.deserializeAttachment();
        if (!viewer || viewer.secretsHash !== hash) socket.close(4001, "key changed");
        else socket.send(JSON.stringify(viewFor(viewer, state)));
      } catch {
        // already gone
      }
    }
    return { players: incoming.size, written: entries.length, removed: gone.length };
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (this.ctx.getWebSockets("server-viewer").length >= MAX_VIEWERS) return refuseSocket(4003, "full");
    const viewer = JSON.parse(request.headers.get("X-Viewer"));
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["server-viewer"]);
    server.serializeAttachment({ ...viewer, secretsHash: await secretsHash(this.env) });
    server.send(JSON.stringify(viewFor(viewer, await this.state())));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() {}

  webSocketClose(socket, code, reason) {
    try { socket.close(code, reason); } catch { /* closed */ }
  }

  webSocketError(socket) {
    try { socket.close(1011, "error"); } catch { /* closed */ }
  }
}

const store = (env) => env.SERVER_STORE.get(env.SERVER_STORE.idFromName("server"));

/** Routes under /server/. Returns null for anything else. */
export async function handleServer(request, env, url, path) {
  if (!path.startsWith("/server/")) return null;

  if (path === "/server/status" && request.method === "POST") {
    const header = request.headers.get("Authorization") || "";
    if (!safeEqual(header.startsWith("Bearer ") ? header.slice(7) : "", env.PUSH_TOKEN)) return json({ error: "unauthorized" }, 401);
    if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) return json({ error: "too large" }, 413);
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "body must be json" }, 400);
    }
    return json({ ok: true, ...(await store(env).publish(payload)) });
  }

  if (path === "/server/live" && request.method === "GET") {
    if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
    const viewer = await viewerFor(env, url.searchParams.get("key"));
    if (!viewer) return refuseSocket(4001, "invite invalid");
    const headers = new Headers(request.headers);
    headers.set("X-Viewer", JSON.stringify(viewer));
    return store(env).fetch(new Request(request.url, { headers }));
  }

  // For the server mod's /mcstatus command: the server proves itself with the
  // push token and gets the key to put in a clickable chat link. The admin key
  // and the link secret never have to be copied into the server's config.
  if (path === "/server/links" && request.method === "POST") {
    const header = request.headers.get("Authorization") || "";
    if (!safeEqual(header.startsWith("Bearer ") ? header.slice(7) : "", env.PUSH_TOKEN)) return json({ error: "unauthorized" }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "body must be json" }, 400);
    }
    const noStore = { "Cache-Control": "no-store" };
    if (body?.admin === true) {
      return env.ADMIN_KEY ? json({ key: env.ADMIN_KEY }, 200, noStore) : json({ error: "ADMIN_KEY not set" }, 503);
    }
    if (!UUID.test(body?.uuid || "")) return json({ error: "uuid or admin required" }, 400);
    if (!env.PLAYER_LINK_SECRET) return json({ error: "PLAYER_LINK_SECRET not set" }, 503);
    return json({ key: await playerKey(env, body.uuid) }, 200, noStore);
  }

  if (path === "/server/link" && request.method === "GET") {
    const viewer = await viewerFor(env, url.searchParams.get("key"));
    if (viewer?.role !== "admin") return json({ error: "admin key required" }, 401);
    const uuid = url.searchParams.get("uuid") || "";
    if (!UUID.test(uuid)) return json({ error: "uuid required" }, 400);
    return json({ key: await playerKey(env, uuid) }, 200, { "Cache-Control": "no-store" });
  }

  return json({ error: "not found" }, 404);
}
