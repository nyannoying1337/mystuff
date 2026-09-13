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
  const stored = await env.STATUS.get("current");
  const players = [];
  if (stored) {
    const status = JSON.parse(stored);
    const player = status.player || {};
    const fresh = Date.now() - (status.received_at || 0) < STALE_MS;
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
      const stored = await env.STATUS.get("current");
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
      await env.STATUS.put("current", JSON.stringify(payload));
      return json({ ok: true });
    }

    if (path === "/shot" && request.method === "GET") {
      const image = await env.STATUS.get("shot", "arrayBuffer");
      if (!image) return json({ error: "no screenshot yet" }, 404);
      const takenAt = (await env.STATUS.get("shot-taken-at")) || "";
      return new Response(image, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-store",
          "X-Taken-At": takenAt,
          ...CORS,
        },
      });
    }

    if (path === "/shot" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

      const image = await request.arrayBuffer();
      if (image.byteLength === 0) return json({ error: "empty body" }, 400);
      if (image.byteLength > 5 * 1024 * 1024) {
        return json({ error: "screenshot too large" }, 413);
      }

      await env.STATUS.put("shot", image);
      await env.STATUS.put("shot-taken-at", String(Date.now()));
      return json({ ok: true, bytes: image.byteLength });
    }

    return json({ error: "not found" }, 404);
  },
};
