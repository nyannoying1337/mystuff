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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
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
