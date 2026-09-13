import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const src = new URL("../worker/worker.js", import.meta.url);
const copy = new URL("./worker-under-test.mjs", import.meta.url);
// Node has no cloudflare:workers; stand in the base class the runtime provides.
writeFileSync(copy, readFileSync(src, "utf8").replace(
  'import { DurableObject } from "cloudflare:workers";',
  "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
));
const mod = await import(copy);
const worker = mod.default;

const kv = new Map();
// The real StatusStore class over a Map shaped like Durable Object storage.
const storage = {
  async get(keyOrKeys) {
    if (Array.isArray(keyOrKeys)) return new Map(keyOrKeys.filter((k) => kv.has(k)).map((k) => [k, kv.get(k)]));
    return kv.get(keyOrKeys);
  },
  async put(entries) { for (const [k, v] of Object.entries(entries)) kv.set(k, v); },
};
const instance = new mod.StatusStore({ storage }, {});
const env = {
  PUSH_TOKEN: "secret-token",
  STORE: { idFromName: (name) => name, get: () => instance },
};
const call = (path, init) => worker.fetch(new Request(`https://w.example${path}`, init), env);

// nothing pushed yet: empty players, not an error
let res = await call("/bluemap/overworld/live/players.json");
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { players: [] });

// push a status like the agent does
res = await call("/status", {
  method: "POST",
  headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
  body: JSON.stringify({
    player: { online: true, name: "nyannoying", dimension: "minecraft:the_nether",
              position: [10.5, 64, -20.3], rotation: [90, 12.5] },
  }),
});
assert.equal(res.status, 200);

res = await call("/bluemap/nether/live/players.json");
let body = await res.json();
assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
assert.deepEqual(body.players[0], {
  uuid: "nyannoying", name: "nyannoying", foreign: false,
  position: { x: 10.5, y: 64, z: -20.3 }, rotation: { yaw: 90, pitch: 12.5, roll: 0 },
});

body = await (await call("/bluemap/overworld/live/players.json")).json();
assert.equal(body.players[0].foreign, true, "other dimension => foreign (hidden)");

assert.deepEqual(await (await call("/bluemap/end/live/markers.json")).json(), {});
assert.equal((await call("/bluemap/../live/players.json")).status, 404);
assert.equal((await call("/bluemap/bogus/live/players.json")).status, 404);

// stale status => no live marker, only a "last seen" one
const stale = JSON.parse(kv.get("current"));
stale.received_at = Date.now() - 120000;
kv.set("current", JSON.stringify(stale));
body = await (await call("/bluemap/nether/live/players.json")).json();
assert.equal(body.players.length, 1);
assert.equal(body.players[0].name, "nyannoying (last seen)");

// hidden coordinates => no marker
const hidden = { ...stale, received_at: Date.now(), player: { ...stale.player, position: null } };
kv.set("current", JSON.stringify(hidden));
assert.deepEqual(await (await call("/bluemap/nether/live/players.json")).json(), { players: [] });

// logged out with a last_seen => "(last seen)" marker on that dimension's map only
kv.set("current", JSON.stringify({
  received_at: Date.now(),
  player: { online: false, name: "nyannoying", hotbar: [] },
  last_seen: { position: [120.5, 64, -33.2], dimension: "minecraft:overworld", at: Date.now() },
}));
body = await (await call("/bluemap/overworld/live/players.json")).json();
assert.deepEqual(body.players[0], {
  uuid: "nyannoying-last-seen", name: "nyannoying (last seen)", foreign: false,
  position: { x: 120.5, y: 64, z: -33.2 }, rotation: { yaw: 0, pitch: 0, roll: 0 },
});
body = await (await call("/bluemap/nether/live/players.json")).json();
assert.equal(body.players[0].foreign, true);

// agent went quiet while online => last known position becomes "last seen"
kv.set("current", JSON.stringify({
  received_at: Date.now() - 600000,
  player: { online: true, name: "nyannoying", dimension: "minecraft:the_nether", position: [5, 70, 5] },
}));
body = await (await call("/bluemap/nether/live/players.json")).json();
assert.equal(body.players[0].name, "nyannoying (last seen)");
assert.equal(body.players[0].foreign, false);

// logged out with hidden coordinates => no marker at all
kv.set("current", JSON.stringify({
  received_at: Date.now(),
  player: { online: false, name: "nyannoying" },
  last_seen: { position: null, dimension: "minecraft:overworld" },
}));
assert.deepEqual(await (await call("/bluemap/overworld/live/players.json")).json(), { players: [] });

// screenshots round-trip through the store
res = await call("/shot", { method: "POST", headers: { Authorization: "Bearer secret-token" }, body: new Uint8Array([1, 2, 3]) });
assert.equal(res.status, 200);
res = await call("/shot");
assert.equal(res.status, 200);
assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
assert.ok(Number(res.headers.get("X-Taken-At")) > 0);

// existing routes still behave
assert.equal((await call("/status", { method: "POST", body: "{}" })).status, 401);
assert.equal((await call("/status")).status, 200);
console.log("ALL WORKER TESTS PASSED");
