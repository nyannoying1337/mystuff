// The status page: puts the live data on screen.
//
// Updates arrive every few seconds but most of the page rarely changes, so the
// view is built from sections that are only rebuilt when their inputs change.
// That keeps tooltips, the 360° view and animations steady, and the browser
// from redoing layout and images for the whole page on every push.
import { assetsReady, glyphWidths } from "./assets.js";
import {
  advancementsPanel, chip, cursesPanel, eventsPanel, gamePanel, itemIcon, mapPanel, modsPanel, panel, playtimePanel, shotsPanel, statRows, statsPanel, worldPanel,
} from "./cards.js";
import { SITE_NAME } from "./config.js";
import { fitPixels, inventoryNode, reattachTooltip, toastNode, tooltipIsPinned, vitalsNode, TOAST_MS } from "./gui.js";
import * as live from "./live.js";
import { panoramaView } from "./panorama.js";
import { loadShots, shotsView } from "./shots.js";
import { demoData, demoShots, isDemo } from "./demo.js";
import { dimensionName, duration, el, timeAgo } from "./util.js";

const DEFAULT_STALE_MS = 90000;           // the Worker sends its own value with each status
const PANORAMA_WINDOW_MS = 10 * 60 * 1000; // a panorama belongs to a logout if taken this close to it

document.title = `${SITE_NAME} · live`;
document.getElementById("brand-name").textContent = SITE_NAME;

const root = document.getElementById("root");
const pill = document.getElementById("live-pill");
const mapButton = document.getElementById("map-button");
const forgetButton = document.getElementById("forget-key");

let lastData = null;
let staleMs = DEFAULT_STALE_MS;
let mapInfo = null;
// Built once when the archive loads: the scrubber holds which frame you're on,
// so rebuilding it on every status push would drag you back to the newest.
let shots = null;

// ---- sections ----------------------------------------------------------------------

const sections = new Map();  // key -> { signature, node }
let used = new Set();

// Returns the node from last time if the inputs are the same, else builds it.
function section(key, inputs, build) {
  used.add(key);
  const signature = JSON.stringify(inputs);
  const previous = sections.get(key);
  if (previous && previous.signature === signature) return previous.node;
  const node = build();
  sections.set(key, { signature, node, rebuilt: true });
  return node;
}

function setChildren(parent, nodes) {
  const wanted = nodes.filter(Boolean);
  const current = [...parent.children];
  if (current.length === wanted.length && current.every((node, i) => node === wanted[i])) return;
  parent.replaceChildren(...wanted);
}

let layout = null;  // the live view's fixed frame; null while a notice screen is up

function liveLayout() {
  if (!layout) {
    const left = el("div", { class: "col" });
    const right = el("div", { class: "col" });
    layout = { hero: el("section", { class: "panel hero" }), left, right, grid: el("div", { class: "grid" }, [left, right]) };
    sections.clear();
  }
  return layout;
}

// ---- small views ---------------------------------------------------------------------

function setPill(state, text) {
  pill.hidden = !state;
  pill.dataset.state = state || "";
  pill.textContent = text || "";
}

// A centered card for everything that isn't the live view.
function showScreen(icon, title, detail, action) {
  lastData = null;
  layout = null;
  setPill(null);
  const card = el("section", { class: "panel card-narrow" }, [itemIcon(icon), el("h1", { text: title }), el("p", { text: detail }), action]);
  root.replaceChildren(el("div", { class: "center" }, [card]));
}

function showJoin(error = "") {
  live.disconnect();
  lastData = null;
  layout = null;
  setPill(null);
  forgetButton.hidden = true;

  const input = el("input", {
    id: "invite-key", name: "key", type: "text", autocomplete: "off", autocapitalize: "off",
    spellcheck: "false", placeholder: "Paste your invite key", required: "", "aria-describedby": "key-error",
  });
  const message = el("p", { class: "error", id: "key-error", role: "alert", text: error });
  if (error) input.setAttribute("aria-invalid", "true");
  input.addEventListener("input", () => {
    message.textContent = "";
    input.removeAttribute("aria-invalid");
  });

  const submit = el("button", { type: "submit", class: "btn btn-green", text: "Join" });
  const form = el("form", { novalidate: "" }, [
    el("div", { class: "field" }, [el("label", { for: "invite-key", text: "Invite key" }), input, message]),
    submit,
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    // accept the whole invite link too, not just the key
    const raw = input.value.trim();
    const fromLink = raw.match(/[#&]key=([^&\s]+)/);
    const key = fromLink ? decodeURIComponent(fromLink[1]) : raw;
    if (!key) {
      message.textContent = "Enter your invite key first.";
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    submit.textContent = "Joining…";
    submit.disabled = true;
    live.rememberKey(key);
    live.connect();
  });

  root.replaceChildren(el("div", { class: "center" }, [el("section", { class: "panel card-narrow" }, [
    itemIcon("grass_block"),
    el("h1", { text: "Watch live" }),
    el("p", { text: "This page is invite-only. Enter the key from your invite to see what's happening in game." }),
    form,
    el("p", { class: "hint", text: "Got an invite link instead? Opening it signs you in automatically." }),
  ])]));
  input.focus();
}

function avatar(name) {
  const head = el("img", { alt: "", src: `https://mc-heads.net/avatar/${encodeURIComponent(name || "MHF_Steve")}/64` });
  // skin service down or blocked: the game's own player head
  head.addEventListener("error", () => { head.src = "assets/mc/item/player_head.png"; }, { once: true });
  return el("div", { class: "avatar" }, [head]);
}

const coords = (position) => position.map((n) => Math.round(n)).join("  ");

const hasInventory = (player) => Boolean((player.hotbar || []).length || (player.inventory || []).length
  || Object.keys(player.armor || {}).length || player.offhand);

// ---- the live view -----------------------------------------------------------------------

function render(data) {
  lastData = data;
  forgetButton.hidden = false;
  const age = Date.now() - (data.received_at || data.generated_at || 0);
  const player = data.player || {};

  if (age > staleMs && !data.last_seen && !hasInventory(player)) {
    showScreen("clock", "The machine went quiet", `Last heard from it ${Math.round(age / 60000)} min ago. This page updates by itself.`);
    return;
  }

  const online = Boolean(player.online) && age <= staleMs;
  // On someone's server only status and inventory are shown: no coordinates,
  // no frame, no map marker (the agent doesn't even send them).
  const multiplayer = player.mode === "multiplayer";
  const seen = data.last_seen || {};

  if (online) setPill(multiplayer ? "server" : "online", multiplayer ? "On a server" : "In game");
  else if (age > staleMs) setPill("quiet", "Quiet");
  else setPill("offline", "Offline");

  const { hero, left, right, grid } = liveLayout();
  used = new Set();

  // ---- hero ----
  const shotSrc = data.screenshot_at
    ? live.frameUrl() || (live.isPolling() ? live.keyedUrl("/shot", data.screenshot_at) : null)
    : null;
  const panoramaUrl = !online && seen.mode === "singleplayer" && data.panorama_at
    && Math.abs((seen.at || 0) - data.panorama_at) <= PANORAMA_WINDOW_MS
    ? live.keyedUrl("/pano", data.panorama_at) : null;
  const panorama = panoramaUrl ? section(`panorama:${panoramaUrl}`, {}, () => panoramaView(panoramaUrl)) : null;
  const fresh = player.advancements?.recent?.[0];
  const toast = glyphWidths && online && !multiplayer && fresh?.at && Date.now() - fresh.at < TOAST_MS ? fresh : null;
  const vitals = glyphWidths && typeof player.health === "number"
    ? [player.health, player.foodlevel, player.xplevel, player.xpp, player.world?.armor] : null;

  const scene = section("scene", {
    shotSrc: panorama ? null : shotSrc, panoramaUrl, online, multiplayer, vitals, toast: toast?.id,
    captured: data.screenshot_at ? timeAgo(data.screenshot_at) : null, seen: seen.at ? timeAgo(seen.at) : null,
  }, () => {
    const node = el("div", { class: "scene" });
    if (!online) node.dataset.offline = "true";
    if (panorama) {
      node.dataset.panorama = "true";
      node.append(panorama,
        el("div", { class: "scene-status" }, [el("strong", { text: "Logged out" }), el("span", { text: `Last seen ${timeAgo(seen.at)}` })]),
        el("span", { class: "scene-hint" }, [el("b", { text: "360°" }), "Drag to look around"]));
    } else {
      if (shotSrc && !(online && multiplayer)) {
        node.style.backgroundImage = `url("${shotSrc}")`;
        node.setAttribute("role", "img");
        node.setAttribute("aria-label", "The most recent frame of the world.");
        node.append(el("span", { class: "scene-chip", text: `Captured ${timeAgo(data.screenshot_at)}` }));
      }
      if (!online) {
        node.append(el("div", { class: "scene-note" }, [
          el("strong", { text: "Logged out" }),
          el("span", { text: seen.at ? `Last seen ${timeAgo(seen.at)}` : "Not in a world right now" }),
        ]));
      } else if (multiplayer) {
        node.append(el("div", { class: "scene-note" }, [
          el("strong", { text: "On a server" }),
          el("span", { text: "No frames or coordinates from other people's worlds." }),
        ]));
      }
    }
    // offline these are what you logged out with, greyed out
    if (vitals) node.append(el("div", { class: "vitals-dock" }, [vitalsNode(player)]));
    if (toast) node.append(el("div", { class: "toast-dock" }, [toastNode(toast)]));
    return node;
  });

  const chips = [];
  if (online && multiplayer) chips.push(["", "Multiplayer server"]);
  else if (online) {
    if (player.dimension) chips.push(["", dimensionName(player.dimension)]);
    if (player.position) chips.push(["XYZ", coords(player.position)]);
  } else if (seen.mode === "multiplayer") chips.push(["Last on", "a multiplayer server"]);
  else if (seen.at) {
    if (seen.dimension) chips.push(["Last in", dimensionName(seen.dimension)]);
    if (seen.position) chips.push(["XYZ", coords(seen.position)]);
  }
  if (online && player.joined_at) chips.push(["Playing for", duration((Date.now() - player.joined_at) / 1000)]);
  if (online && !glyphWidths) {
    chips.push(["Health", `${Math.ceil(player.health ?? 0) / 2} ♥`], ["Food", `${(player.foodlevel ?? 0) / 2}`], ["Level", String(player.xplevel ?? 0)]);
  }
  const identity = section("identity", { name: player.name, chips }, () => el("div", { class: "identity" }, [
    avatar(player.name),
    el("div", { class: "who" }, [
      el("h1", { text: player.name || "Unknown player" }),
      el("div", { class: "chips" }, chips.map(([label, value]) => chip(label, value))),
    ]),
  ]));

  setChildren(hero, [scene, identity]);

  // ---- left column ----
  const inventoryInputs = [online, player.name, player.hotbar, player.inventory, player.armor, player.offhand, Boolean(glyphWidths)];
  const inventory = section("inventory", inventoryInputs, () => {
    if (!hasInventory(player)) return panel("Inventory", [el("p", { class: "empty", text: "Nothing in the inventory." })]);
    return panel(online ? "Inventory" : "Logged out with", [
      glyphWidths
        ? el("div", { class: "inventory-well" }, [inventoryNode(player)])
        : statRows([
          ["Health", `${Math.ceil(player.health ?? 0)} / 20`],
          ["Food", `${player.foodlevel ?? 0} / 20`],
          ["Level", player.xplevel ?? 0],
        ]),
    ]);
  });
  const inventoryRebuilt = sections.get("inventory").rebuilt;
  // your own worlds only: the agent never sends these for servers
  const adv = player.advancements;
  setChildren(left, [
    inventory,
    adv?.total ? section("advancements", [adv, (adv.recent || []).map((item) => item.at && timeAgo(item.at))], () => advancementsPanel(adv)) : null,
  ]);

  // ---- right column ----
  const curses = Array.isArray(data.curses) && data.curses.length ? data.curses : null;
  const events = Array.isArray(data.events) && data.events.length ? data.events : null;
  const mods = Array.isArray(player.mods) && player.mods.length ? player.mods : null;
  const playtime = Array.isArray(data.playtime) && data.playtime.some((day) => day.seconds >= 60) ? data.playtime : null;
  mapButton.hidden = !mapInfo;
  setChildren(right, [
    online && !multiplayer && player.world ? section("world", player.world, () => worldPanel(player.world)) : null,
    online && player.game ? section("game", player.game, () => gamePanel(player.game)) : null,
    events ? section("events", events, () => eventsPanel(events)) : null,
    shots ? section("shots", shots.count, () => shotsPanel(shots.node, shots.count)) : null,
    playtime ? section("playtime", playtime, () => playtimePanel(playtime)) : null,
    mapInfo ? section("map", [mapInfo, player.name, timeAgo(mapInfo.rendered_at)], () => mapPanel(mapInfo, player.name)) : null,
    curses ? section("curses", [curses, curses.map((curse) => timeAgo(curse.at))], () => cursesPanel(curses)) : null,
    mods ? section("mods", mods, () => modsPanel(mods)) : null,
  ]);
  grid.style.gridTemplateColumns = right.childElementCount ? "" : "minmax(0, 1fr)";
  if (!right.childElementCount) right.remove();
  else if (right.parentNode !== grid) grid.append(right);

  const stats = player.stats && !multiplayer ? section("stats", [player.stats, online], () => statsPanel(player.stats, online)) : null;
  setChildren(root, [hero, grid, stats]);

  for (const [key, entry] of sections) {
    if (!used.has(key)) sections.delete(key);
    else entry.rebuilt = false;
  }
  fitPixels();
  if (inventoryRebuilt) reattachTooltip(root);
}

// ---- wiring ---------------------------------------------------------------------------------

forgetButton.addEventListener("click", () => {
  live.forgetKey();
  showJoin();
});

// The map is rendered separately and may not exist yet; only link it if it does.
fetch("map/mc-status.json", { cache: "no-store" })
  .then((response) => (response.ok ? response.json() : null))
  .then((info) => {
    mapInfo = info;
    if (mapInfo && lastData) render(lastData);
  })
  .catch(() => {});

// The frame archive is published separately and may not exist yet.
if (!isDemo) loadShots().then((archive) => {
  if (!archive) return;
  shots = { ...shotsView(archive), count: archive.frames.length };
  if (lastData) render(lastData);
});

// "3 min ago" labels age locally; no requests
setInterval(() => {
  if (lastData && !document.hidden && !tooltipIsPinned()) render(lastData);
}, 30000);

if (isDemo) {
  // Everything below this point would otherwise be driven by the Worker. In demo
  // mode the page is the only moving part, so a card that renders here and not on
  // the real page means the data never arrived — not that the page is broken.
  document.body.classList.add("is-demo");
  document.body.append(el("div", { class: "demo-badge", text: "Demo data — nothing here is real" }));
  shots = { ...shotsView(demoShots()), count: demoShots().frames.length };
  assetsReady.then(() => render(demoData()));
} else {
live.start({
  async status(data, stale) {
    if (stale) staleMs = stale;
    await assetsReady;
    render(data);
  },
  frame() { if (lastData) render(lastData); },
  empty() { showScreen("clock", "Nothing reported yet", "The agent hasn't sent anything. This page updates by itself."); },
  join: showJoin,
  full(max) {
    const retry = el("button", { type: "button", class: "btn btn-green", text: "Try again" });
    retry.addEventListener("click", () => live.connect());
    showScreen("spyglass", "Too many people are watching",
      `Only ${max || "a few"} people can watch at once. Try again in a bit.`, retry);
  },
  unreachable() { if (!lastData) showScreen("redstone_torch", "Can't reach the server", "Retrying by itself."); },
});
}
fitPixels();
