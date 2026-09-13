import { DurableObject } from "cloudflare:workers";

// Most people watching live at once; the rest get a "try again later".
const MAX_VIEWERS = 10;

// Same ids as MAPS in map/render.py.
const MAP_DIMENSIONS = {
  overworld: "minecraft:overworld",
  nether: "minecraft:the_nether",
  end: "minecraft:the_end",
};

// Older than this and the page calls the machine quiet, and the live marker
// becomes "last seen". Sent to the page with every status.
const STALE_MS = 90000;

// Durable Object values max out at 2 MB.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024 - 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

// constant-time-ish compare so secrets can't be guessed byte by byte
function safeEqual(given, expected) {
  if (!expected || typeof given !== "string" || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function authorized(request, env) {
  const header = request.headers.get("Authorization") || "";
  return safeEqual(header.startsWith("Bearer ") ? header.slice(7) : "", env.PUSH_TOKEN);
}

// Live data is invite-only: the page passes the key from its invite link.
function canView(url, env) {
  return safeEqual(url.searchParams.get("key") || "", env.VIEW_KEY);
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// BlueMap player markers for one map, from a status push.
export function playersFor(status, mapId) {
  const players = [];
  if (!status) return { players };
  const player = status.player || {};
  const fresh = Date.now() - (status.received_at || 0) < STALE_MS;
  const seen = status.last_seen || {};
  if (fresh && player.online && Array.isArray(player.position)) {
    const [x, y, z] = player.position;
    const [yaw, pitch] = Array.isArray(player.rotation) ? player.rotation : [0, 0];
    players.push({
      // The name stands in for the uuid; BlueMap only uses it as a key and
      // for a head image it won't find, so it falls back to Steve.
      uuid: player.name,
      name: player.name,
      foreign: player.dimension !== MAP_DIMENSIONS[mapId],
      position: { x, y, z },
      rotation: { yaw, pitch, roll: 0 },
    });
  } else if (player.name) {
    // Logged out (or the machine went quiet): mark where they were last,
    // which is also what the logout map was rendered around.
    const spot = !player.online && Array.isArray(seen.position)
      ? { position: seen.position, dimension: seen.dimension }
      : { position: player.position, dimension: player.dimension };
    if (Array.isArray(spot.position)) {
      const [x, y, z] = spot.position;
      players.push({
        uuid: `${player.name}-last-seen`,
        name: `${player.name} (last seen)`,
        foreign: spot.dimension !== MAP_DIMENSIONS[mapId],
        position: { x, y, z },
        rotation: { yaw: 0, pitch: 0, roll: 0 },
      });
    }
  }
  return { players };
}

function statusMessage(current) {
  const status = JSON.parse(current);
  const players = Object.fromEntries(Object.keys(MAP_DIMENSIONS).map((id) => [id, playersFor(status, id)]));
  return JSON.stringify({ type: "status", status, players, stale_ms: STALE_MS });
}

// A WebSocket that is closed straight away, so the browser can see why.
function refuseSocket(code, reason, message) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  if (message) server.send(JSON.stringify(message));
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

// All state lives in one SQLite-backed Durable Object, which also holds the
// viewers' WebSockets.
//
// Free-tier notes: KV allows 1,000 writes a day, these Durable Objects 100,000.
// Opening a WebSocket costs one request, while messages sent to viewers and
// the ping auto-responses are free — so the agent's push is broadcast at no
// cost, instead of every viewer polling every few seconds.
export class StatusStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (typeof WebSocketRequestResponsePair !== "undefined") {
      // answered by the runtime without waking the object
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  async read(key) {
    return (await this.ctx.storage.get(key)) ?? null;
  }

  async readMany(keys) {
    return Object.fromEntries(await this.ctx.storage.get(keys));
  }

  async publishStatus(current) {
    await this.ctx.storage.put({ current });
    await this.broadcast(statusMessage(current));
  }

  async publishShot(image) {
    await this.ctx.storage.put({ shot: image, "shot-taken-at": String(Date.now()) });
    await this.broadcast(image);
  }

  // The logout panorama isn't broadcast: the page fetches it only when it shows it.
  async storePanorama(image) {
    await this.ctx.storage.put({ pano: image });
  }

  viewerCount() {
    return this.ctx.getWebSockets("viewer").length;
  }

  async broadcast(message) {
    // Rotating the invite key disconnects everyone who joined with the old one.
    const keyHash = await sha256(this.env.VIEW_KEY || "");
    for (const socket of this.ctx.getWebSockets("viewer")) {
      try {
        const attachment = socket.deserializeAttachment();
        if (!attachment || attachment.keyHash !== keyHash) {
          socket.close(4001, "invite changed");
        } else {
          socket.send(message);
        }
      } catch {
        // already gone; the runtime drops it from getWebSockets
      }
    }
  }

  // WebSocket upgrades, forwarded by the Worker once the key checked out.
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (this.viewerCount() >= MAX_VIEWERS) {
      return refuseSocket(4003, "full", { type: "full", max: MAX_VIEWERS });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["viewer"]);
    server.serializeAttachment({ keyHash: request.headers.get("X-Key-Hash") });

    const { current, shot } = await this.readMany(["current", "shot"]);
    server.send(current ? statusMessage(current) : JSON.stringify({ type: "empty" }));
    if (shot) server.send(shot);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() {
    // viewers only listen; "ping" is answered by the auto-response
  }

  webSocketClose(socket, code, reason) {
    try {
      socket.close(code, reason);
    } catch {
      // already closed
    }
  }

  webSocketError(socket) {
    try {
      socket.close(1011, "error");
    } catch {
      // already closed
    }
  }
}

function store(env) {
  return env.STORE.get(env.STORE.idFromName("status"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path === "/live" && request.method === "GET") {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
      // Refused here, before the Durable Object is touched.
      if (!canView(url, env)) return refuseSocket(4001, "invite invalid");
      const headers = new Headers(request.headers);
      headers.set("X-Key-Hash", await sha256(env.VIEW_KEY));
      return store(env).fetch(new Request(request.url, { headers }));
    }

    const live = path.match(/^\/bluemap\/([a-z0-9_-]+)\/live\/(players|markers)\.json$/);
    if (live && request.method === "GET") {
      const [, mapId, file] = live;
      if (!(mapId in MAP_DIMENSIONS)) return json({ error: "unknown map" }, 404);
      if (file === "markers") return json({}, 200, { "Cache-Control": "max-age=300" });
      // The map page gets markers over the WebSocket; this is only a keyed fallback.
      if (!canView(url, env)) return json({ players: [] }, 200, { "Cache-Control": "no-store" });
      const stored = await store(env).read("current");
      return json(playersFor(stored && JSON.parse(stored), mapId), 200, { "Cache-Control": "no-store" });
    }

    if (path === "/status" && request.method === "GET") {
      if (!canView(url, env)) return json({ error: "invite required" }, 401);
      const stored = await store(env).read("current");
      if (!stored) return json({ state: "never-reported" }, 404);
      return new Response(stored, {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
      });
    }

    if (path === "/status" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "body must be json" }, 400);
      }

      payload.received_at = Date.now();
      await store(env).publishStatus(JSON.stringify(payload));
      return json({ ok: true });
    }

    if (path === "/shot" && request.method === "GET") {
      if (!canView(url, env)) return json({ error: "invite required" }, 401);
      const { shot, "shot-taken-at": takenAt } = await store(env).readMany(["shot", "shot-taken-at"]);
      if (!shot) return json({ error: "no screenshot yet" }, 404);
      return new Response(shot, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-store",
          "X-Taken-At": takenAt || "",
          ...CORS,
        },
      });
    }

    if ((path === "/shot" || path === "/pano") && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      const image = await request.arrayBuffer();
      if (image.byteLength === 0) return json({ error: "empty body" }, 400);
      if (image.byteLength > MAX_IMAGE_BYTES) return json({ error: "image too large" }, 413);
      if (path === "/shot") await store(env).publishShot(image);
      else await store(env).storePanorama(image);
      return json({ ok: true, bytes: image.byteLength });
    }

    if (path === "/pano" && request.method === "GET") {
      if (!canView(url, env)) return json({ error: "invite required" }, 401);
      const pano = await store(env).read("pano");
      if (!pano) return json({ error: "no panorama yet" }, 404);
      // The page adds ?t=<panorama_at>, so each panorama is its own URL and can be cached for good.
      return new Response(pano, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", ...CORS },
      });
    }

    return json({ error: "not found" }, 404);
  },
};
