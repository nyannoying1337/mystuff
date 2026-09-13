// Worker routes and the StatusStore's broadcast logic, in plain Node.
// The WebSocket upgrade itself needs the Workers runtime: see tests/live_socket_test.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const src = new URL("../worker/worker.js", import.meta.url);
const copy = new URL("./worker-under-test.mjs", import.meta.url);
// Node has no cloudflare:workers; stand in the base class the runtime provides.
const STUB = "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }";
writeFileSync(new URL("./server-under-test.mjs", import.meta.url), readFileSync(new URL("../worker/server.js", import.meta.url), "utf8")
  .replace('import { DurableObject } from "cloudflare:workers";', STUB));
writeFileSync(copy, readFileSync(src, "utf8")
  .replace('import { DurableObject } from "cloudflare:workers";', STUB)
  .replaceAll('"./server.js"', '"./server-under-test.mjs"'));
const mod = await import(copy);
const worker = mod.default;

const kv = new Map();
const sockets = [];
const storage = {
  async get(keyOrKeys) {
    if (Array.isArray(keyOrKeys)) return new Map(keyOrKeys.filter((k) => kv.has(k)).map((k) => [k, kv.get(k)]));
    return kv.get(keyOrKeys);
  },
  async put(entries) { for (const [k, v] of Object.entries(entries)) kv.set(k, v); },
};
const env = { PUSH_TOKEN: "secret-token", VIEW_KEY: "view-key-123" };
const instance = new mod.StatusStore({ storage, getWebSockets: () => sockets.filter((s) => !s.closed) }, env);
env.STORE = { idFromName: (name) => name, get: () => instance };

const call = (path, init) => worker.fetch(new Request(`https://w.example${path}`, init), env);
const push = (body) => call("/status", {
  method: "POST",
  headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const K = "?key=view-key-123";

async function fakeSocket(key) {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const socket = {
    sent: [], closed: null,
    deserializeAttachment: () => ({ keyHash: hash }),
    send(message) { this.sent.push(message); },
    close(code, reason) { this.closed = { code, reason }; },
  };
  sockets.push(socket);
  return socket;
}

// --- reading live data needs the invite key
assert.equal((await call("/status")).status, 401);
assert.equal((await call("/status?key=wrong")).status, 401);
assert.equal((await call(`/status${K}`)).status, 404, "nothing pushed yet");
assert.deepEqual(await (await call("/bluemap/overworld/live/players.json")).json(), { players: [] });
assert.deepEqual(await (await call("/bluemap/end/live/markers.json")).json(), {});
assert.equal((await call("/bluemap/bogus/live/players.json")).status, 404);
assert.equal((await call("/live")).status, 426, "plain GET on /live is refused");

// --- pushing needs the push token, and broadcasts to viewers with the current key
const viewer = await fakeSocket("view-key-123");
const oldViewer = await fakeSocket("old-key");
assert.equal((await call("/status", { method: "POST", body: "{}" })).status, 401);
assert.equal((await push({
  player: { online: true, name: "nyannoying", dimension: "minecraft:the_nether", position: [10.5, 64, -20.3], rotation: [90, 12.5] },
})).status, 200);

assert.equal(viewer.sent.length, 1);
const message = JSON.parse(viewer.sent[0]);
assert.equal(message.type, "status");
assert.equal(message.status.player.name, "nyannoying");
assert.ok(message.status.received_at > 0);
assert.deepEqual(message.players.nether.players[0], {
  uuid: "nyannoying", name: "nyannoying", foreign: false,
  position: { x: 10.5, y: 64, z: -20.3 }, rotation: { yaw: 90, pitch: 12.5, roll: 0 },
});
assert.equal(message.players.overworld.players[0].foreign, true, "other dimension => hidden");
assert.deepEqual(oldViewer.sent, [], "a socket from an old key gets nothing");
assert.deepEqual(oldViewer.closed, { code: 4001, reason: "invite changed" });

// --- keyed HTTP fallbacks
assert.equal((await (await call(`/status${K}`)).json()).player.name, "nyannoying");
let body = await (await call(`/bluemap/nether/live/players.json${K}`)).json();
assert.equal(body.players[0].name, "nyannoying");

// --- screenshots: stored, broadcast as binary, keyed fetch
assert.equal((await call("/shot", { method: "POST", headers: { Authorization: "Bearer secret-token" }, body: new Uint8Array([1, 2, 3]) })).status, 200);
assert.ok(viewer.sent[1] instanceof ArrayBuffer);
assert.deepEqual([...new Uint8Array(viewer.sent[1])], [1, 2, 3]);
assert.equal((await call("/shot")).status, 401);
const shot = await call(`/shot${K}`);
assert.equal(shot.status, 200);
assert.deepEqual([...new Uint8Array(await shot.arrayBuffer())], [1, 2, 3]);
assert.ok(Number(shot.headers.get("X-Taken-At")) > 0);

// --- logout panorama: stored, not broadcast, keyed and cacheable fetch
const sentBefore = viewer.sent.length;
assert.equal((await call(`/pano${K}`)).status, 404, "no panorama yet");
assert.equal((await call("/pano", { method: "POST", body: new Uint8Array([9]) })).status, 401, "push token required");
assert.equal((await call("/pano", { method: "POST", headers: { Authorization: "Bearer secret-token" }, body: new Uint8Array(0) })).status, 400);
assert.equal((await call("/pano", { method: "POST", headers: { Authorization: "Bearer secret-token" }, body: new Uint8Array(2 * 1024 * 1024) })).status, 413);
assert.equal((await call("/pano", { method: "POST", headers: { Authorization: "Bearer secret-token" }, body: new Uint8Array([7, 8, 9]) })).status, 200);
assert.equal(viewer.sent.length, sentBefore, "panoramas aren't pushed to viewers");
assert.equal((await call("/pano")).status, 401);
const pano = await call(`/pano${K}&t=123`);
assert.equal(pano.status, 200);
assert.deepEqual([...new Uint8Array(await pano.arrayBuffer())], [7, 8, 9]);
assert.match(pano.headers.get("Cache-Control"), /immutable/);

// --- the status message tells the page when to call the machine quiet
await push({ player: { online: false } });
assert.equal(JSON.parse(viewer.sent.at(-1)).stale_ms, 90000);

// --- playersFor: marker rules
const { playersFor } = mod;
const now = Date.now();
assert.equal(playersFor({ received_at: now - 120000, player: { online: true, name: "n", dimension: "minecraft:the_nether", position: [5, 70, 5] } }, "nether").players[0].name,
  "n (last seen)", "stale online => last seen");
assert.deepEqual(playersFor({ received_at: now, player: { online: false, name: "n" }, last_seen: { position: [120.5, 64, -33.2], dimension: "minecraft:overworld" } }, "overworld").players[0], {
  uuid: "n-last-seen", name: "n (last seen)", foreign: false,
  position: { x: 120.5, y: 64, z: -33.2 }, rotation: { yaw: 0, pitch: 0, roll: 0 },
});
assert.equal(playersFor({ received_at: now, player: { online: false, name: "n" }, last_seen: { position: [1, 2, 3], dimension: "minecraft:overworld" } }, "nether").players[0].foreign, true);
assert.deepEqual(playersFor({ received_at: now, player: { online: false, name: "n" }, last_seen: { position: null } }, "overworld"), { players: [] }, "hidden coords => no marker");
assert.deepEqual(playersFor({ received_at: now, player: { online: true, name: "n", position: null } }, "overworld"), { players: [] });
assert.deepEqual(playersFor(null, "overworld"), { players: [] });

console.log("ALL WORKER TESTS PASSED");
