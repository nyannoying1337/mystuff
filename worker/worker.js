import { DurableObject } from "cloudflare:workers";

// All state lives in one SQLite-backed Durable Object. On the Workers Free
// plan, KV allows 1,000 writes a day — an agent pushing every 10 s uses that
// up in under three hours — while these Durable Objects allow 100,000.
export class StatusStore extends DurableObject {
  async read(key) {
    return (await this.ctx.storage.get(key)) ?? null;
  }

  async readMany(keys) {
    return Object.fromEntries(await this.ctx.storage.get(keys));
  }

  async write(entries) {
    await this.ctx.storage.put(entries);
  }
}

function store(env) {
  return env.STORE.get(env.STORE.idFromName("status"));
}

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

function authorized(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!env.PUSH_TOKEN || token.length !== env.PUSH_TOKEN.length) return false;
  // constant-time-ish compare so the token can't be guessed byte by byte
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ env.PUSH_TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

// Same ids as MAPS in map/render.py.
const MAP_DIMENSIONS = {
  overworld: "minecraft:overworld",
  nether: "minecraft:the_nether",
  end: "minecraft:the_end",
};

// Matches the status page: older than this and the marker disappears.
const STALE_MS = 90000;

// BlueMap's webapp reads live data from <live-data-root>/<map>/live/*.json.
// This answers those requests from the last status push, so the static map on
// GitHub Pages shows where you are right now.
async function bluemapPlayers(env, mapId) {
  const stored = await store(env).read("current");
  const players = [];
  if (stored) {
    const status = JSON.parse(stored);
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
  }
  return json({ players }, 200, { "Cache-Control": "no-store" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const live = path.match(/^\/bluemap\/([a-z0-9_-]+)\/live\/(players|markers)\.json$/);
    if (live && request.method === "GET") {
      const [, mapId, file] = live;
      if (!(mapId in MAP_DIMENSIONS)) return json({ error: "unknown map" }, 404);
      if (file === "markers") return json({}, 200, { "Cache-Control": "max-age=300" });
      return bluemapPlayers(env, mapId);
    }

    if (path === "/status" && request.method === "GET") {
      const stored = await store(env).read("current");
      if (!stored) {
        return json({ state: "never-reported" }, 404);
      }
      return new Response(stored, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...CORS,
        },
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
      await store(env).write({ current: JSON.stringify(payload) });
      return json({ ok: true });
    }

    if (path === "/shot" && request.method === "GET") {
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

    if (path === "/shot" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

      const image = await request.arrayBuffer();
      if (image.byteLength === 0) return json({ error: "empty body" }, 400);
      // Durable Object values max out at 2 MB; the agent sends ~50 kB JPEGs.
      if (image.byteLength > 2 * 1024 * 1024 - 1024) {
        return json({ error: "screenshot too large" }, 413);
      }

      await store(env).write({ shot: image, "shot-taken-at": String(Date.now()) });
      return json({ ok: true, bytes: image.byteLength });
    }

    return json({ error: "not found" }, 404);
  },
};
