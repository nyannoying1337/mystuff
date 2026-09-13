// PROOF OF CONCEPT: the server tool's Worker routes, in plain Node.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const copy = new URL("./server-under-test.mjs", import.meta.url);
writeFileSync(copy, readFileSync(new URL("../worker/server.js", import.meta.url), "utf8").replace(
  'import { DurableObject } from "cloudflare:workers";',
  "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
));
const mod = await import(copy);

const rows = new Map();
const sockets = [];
const storage = {
  async list({ prefix }) { return new Map([...rows].filter(([k]) => k.startsWith(prefix)).sort()); },
  async put(entries) { for (const [k, v] of Object.entries(entries)) rows.set(k, v); },
  async delete(keys) { for (const k of keys) rows.delete(k); },
};
const env = { PUSH_TOKEN: "push-secret", ADMIN_KEY: "admin-key-123", PLAYER_LINK_SECRET: "link-secret-456" };
const instance = new mod.ServerStore({ storage, getWebSockets: () => sockets.filter((s) => !s.closed), acceptWebSocket() {} }, env);
env.SERVER_STORE = { idFromName: (n) => n, get: () => instance };

const call = (path, init) => {
  const url = new URL(`https://w.example${path}`);
  return mod.handleServer(new Request(url, init), env, url, url.pathname);
};
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const push = (players) => call("/server/status", {
  method: "POST", headers: { Authorization: "Bearer push-secret", "Content-Type": "application/json" },
  body: JSON.stringify({ server: { name: "Test", tps: 20 }, players }),
});

// --- keys: admin, signed player links, and everything else refused
assert.deepEqual(await mod.viewerFor(env, "admin-key-123"), { role: "admin" });
const aliceKey = await mod.playerKey(env, ALICE);
assert.deepEqual(await mod.viewerFor(env, aliceKey), { role: "player", uuid: ALICE });
assert.equal(await mod.viewerFor(env, `${BOB}.${aliceKey.split(".")[1]}`), null, "a signature only works for its own uuid");
assert.equal(await mod.viewerFor(env, `${ALICE}.forged`), null);
assert.equal(await mod.viewerFor(env, "nope"), null);
assert.equal(await mod.viewerFor({ ...env, PLAYER_LINK_SECRET: "rotated" }, aliceKey), null, "rotating the secret revokes links");

// --- links are admin-only
assert.equal((await call(`/server/link?key=${encodeURIComponent(aliceKey)}&uuid=${BOB}`)).status, 401, "players can't mint links");
const link = await call(`/server/link?key=admin-key-123&uuid=${ALICE}`);
assert.equal(link.status, 200);
assert.equal((await link.json()).key, aliceKey);

// --- the server mod's /mcstatus command gets links with the push token
const links = (body, token = "push-secret") => call("/server/links", {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
});
assert.equal((await links({ admin: true }, "wrong")).status, 401, "only the server can ask");
assert.equal((await links({ admin: true }, aliceKey)).status, 401, "a player key is not the push token");
assert.equal((await (await links({ admin: true })).json()).key, "admin-key-123");
assert.equal((await (await links({ uuid: ALICE })).json()).key, aliceKey);
assert.equal((await links({ uuid: "not-a-uuid" })).status, 400);

// --- pushes need the push token; players are stored as separate rows
assert.equal((await call("/server/status", { method: "POST", body: "{}" })).status, 401);
const first = await (await push([{ uuid: ALICE, name: "Alice", online: true, position: [1, 2, 3] }, { uuid: BOB, name: "Bob", online: false }])).json();
assert.deepEqual(first, { ok: true, players: 2, written: 3, removed: 0 });
assert.ok(rows.has(`server:player:${ALICE}`) && rows.has(`server:player:${BOB}`));
const again = await (await push([{ uuid: ALICE, name: "Alice", online: true, position: [1, 2, 3] }, { uuid: BOB, name: "Bob", online: false }])).json();
assert.equal(again.written, 1, "unchanged players aren't rewritten, only the meta row");

// --- live views: admin sees everyone, a player only themselves
function socket(viewer, hashOverride) {
  const s = { sent: [], closed: null, send(m) { this.sent.push(JSON.parse(m)); }, close(code) { this.closed = { code }; } };
  s.deserializeAttachment = () => ({ ...viewer, secretsHash: hashOverride ?? s.hash });
  sockets.push(s);
  return s;
}
const secretsHash = async () => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.ADMIN_KEY}|${env.PLAYER_LINK_SECRET}`));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const admin = socket({ role: "admin" }); admin.hash = await secretsHash();
const alice = socket({ role: "player", uuid: ALICE }); alice.hash = await secretsHash();
const stale = socket({ role: "admin" }, "old-hash");
await push([{ uuid: ALICE, name: "Alice", online: true, position: [5, 6, 7] }, { uuid: BOB, name: "Bob", online: true, position: [9, 9, 9] }]);
assert.deepEqual(admin.sent.at(-1).players.map((p) => p.name), ["Alice", "Bob"]);
assert.equal(admin.sent.at(-1).role, "admin");
assert.deepEqual(alice.sent.at(-1).players.map((p) => p.name), ["Alice"], "a player never receives anyone else");
assert.equal(alice.sent.at(-1).you, ALICE);
assert.ok(!JSON.stringify(alice.sent).includes("Bob"));
assert.equal(stale.closed?.code, 4001, "sockets from before a key change are closed");

// --- players who drop out of the push are removed
const removed = await (await push([{ uuid: ALICE, name: "Alice", online: true }])).json();
assert.equal(removed.removed, 1);
assert.deepEqual((await instance.state()).players.map((p) => p.name), ["Alice"]);

console.log("ALL SERVER TOOL WORKER TESTS PASSED");
