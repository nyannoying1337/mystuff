// End-to-end WebSocket test against `wrangler dev` (the real Workers runtime).
//
//   cd worker && npx wrangler dev --port 8788      (uses worker/.dev.vars:
//                                                    PUSH_TOKEN=local-test-token
//                                                    VIEW_KEY=local-view-key)
//   node tests/live_socket_test.mjs
import assert from "node:assert/strict";

const BASE = process.env.WORKER_URL || "http://127.0.0.1:8788";
const WS = BASE.replace(/^http/, "ws");
const PUSH = process.env.PUSH_TOKEN || "local-test-token";
const KEY = process.env.VIEW_KEY || "local-view-key";
const MAX = 10;

function connect(key) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${WS}/live${key === undefined ? "" : `?key=${encodeURIComponent(key)}`}`);
    socket.binaryType = "arraybuffer";
    const client = { socket, messages: [], closed: null, opened: false };
    socket.addEventListener("open", () => { client.opened = true; });
    socket.addEventListener("message", (event) => {
      client.messages.push(typeof event.data === "string" ? JSON.parse(event.data) : event.data);
    });
    socket.addEventListener("close", (event) => { client.closed = { code: event.code, reason: event.reason }; resolve(client); });
    // resolve once we either got the initial state or were closed
    setTimeout(() => resolve(client), 1500);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body, type = "application/json") => fetch(`${BASE}${path}`, {
  method: "POST", headers: { Authorization: `Bearer ${PUSH}`, "Content-Type": type }, body,
});

// seed state
assert.equal((await post("/status", JSON.stringify({ player: { online: true, name: "tester", dimension: "minecraft:overworld", position: [1, 64, 2] } }))).status, 200);
assert.equal((await post("/shot", new Uint8Array([9, 8, 7]), "image/jpeg")).status, 200);

// 1. no key / wrong key => told why, closed 4001
for (const key of [undefined, "wrong"]) {
  const refused = await connect(key);
  await sleep(300);
  assert.equal(refused.closed?.code, 4001, `key=${key} should be refused`);
  assert.equal(refused.messages.length, 0, "the close code says it all");
}
console.log("ok  no/wrong key refused with 4001");

// 2. valid key => current status + screenshot immediately
const first = await connect(KEY);
assert.equal(first.closed, null);
assert.equal(first.messages[0].type, "status");
assert.equal(first.messages[0].status.player.name, "tester");
assert.equal(first.messages[0].players.overworld.players[0].name, "tester");
assert.deepEqual([...new Uint8Array(first.messages[1])], [9, 8, 7]);
console.log("ok  viewer gets current status and screenshot on connect");

// 3. push => every viewer receives it
const viewers = [first];
for (let i = 1; i < MAX; i++) viewers.push(await connect(KEY));
assert.ok(viewers.every((v) => v.closed === null), "10 viewers fit");
const before = viewers.map((v) => v.messages.length);
assert.equal((await post("/status", JSON.stringify({ player: { online: true, name: "tester", dimension: "minecraft:overworld", position: [50, 70, 60] } }))).status, 200);
await sleep(700);
viewers.forEach((v, i) => {
  const last = v.messages.at(-1);
  assert.equal(v.messages.length, before[i] + 1, `viewer ${i} got the push`);
  assert.deepEqual(last.status.player.position, [50, 70, 60]);
});
console.log(`ok  push broadcast to all ${MAX} viewers`);

// 4. the 11th is turned away
const extra = await connect(KEY);
await sleep(300);
assert.equal(extra.closed?.code, 4003);
assert.deepEqual(extra.messages[0], { type: "full", max: MAX });
console.log("ok  viewer 11 refused with 4003 'full'");

// 5. a slot frees up when someone leaves
viewers.pop().socket.close(1000, "bye");
await sleep(800);
const replacement = await connect(KEY);
assert.equal(replacement.closed, null, "slot reused after a viewer left");
viewers.push(replacement);
console.log("ok  freed slot is reusable");

// 6. keyed HTTP fallback still works, unkeyed does not
assert.equal((await fetch(`${BASE}/status`)).status, 401);
assert.equal((await fetch(`${BASE}/status?key=${KEY}`)).status, 200);
console.log("ok  keyed HTTP fallback");

viewers.forEach((v) => v.socket.close(1000, "done"));
await sleep(300);
console.log("ALL LIVE SOCKET TESTS PASSED");
process.exit(0);
