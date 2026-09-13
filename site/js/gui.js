// Game GUIs drawn from the game's own sprites: the vitals, the advancement
// toast and the inventory screen, plus the item tooltip.
import { ASSETS, enchantmentName, glyphWidths, itemName, itemUrl, spriteUrl } from "./assets.js";
import { el } from "./util.js";

// ---- pixel-exact scaling -------------------------------------------------------

// A box measured in GUI pixels; children are placed by percentage so the whole
// thing scales as one image would. fitPixels() gives it a whole number of
// screen pixels per GUI pixel. `fill` is the share of its container it aims
// for, `min` a width in CSS px it tries to reach, `max` the largest CSS px per
// GUI pixel.
export function makeGui(width, height, className, { fill = 1, min = 0, max = 3 } = {}) {
  const node = el("div", { class: `gui ${className}` });
  node.style.aspectRatio = `${width} / ${height}`;
  Object.assign(node.dataset, { native: width, fill, min, max });
  return {
    node,
    add(child, x, y, w, h) {
      child.style.left = `${(x / width) * 100}%`;
      child.style.top = `${(y / height) * 100}%`;
      child.style.width = `${(w / width) * 100}%`;
      child.style.height = `${(h / height) * 100}%`;
      node.append(child);
      return child;
    },
  };
}

// Pixel art only stays sharp when each texture pixel covers a whole number of
// screen pixels. With Windows display scaling (125 %, 150 %) "2×" in CSS isn't,
// so sizes are rounded to the screen: --t1/--t2/--t4 are one texture pixel at
// roughly 1.25, 2 and 4 CSS px, and GUIs get an integer scale.
export function fitPixels(scope = document) {
  const dpr = window.devicePixelRatio || 1;
  const rootStyle = document.documentElement.style;
  for (const [name, scale] of [["--t1", 1.25], ["--t2", 2], ["--t4", 4]]) {
    rootStyle.setProperty(name, `${Math.max(1, Math.round(scale * dpr)) / dpr}px`);
  }
  for (const gui of scope.querySelectorAll(".gui[data-native]")) {
    const parent = gui.parentElement;
    const style = getComputedStyle(parent);
    const box = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (box <= 0) continue;
    const native = Number(gui.dataset.native);
    const target = Math.min(box, Math.max(box * Number(gui.dataset.fill), Number(gui.dataset.min)));
    // nearest whole scale to the target, but never wider than the box or the max
    const fits = Math.floor((box * dpr) / native);
    const wanted = Math.round((target * dpr) / native);
    const scale = Math.max(1, Math.min(wanted, fits, Math.round(Number(gui.dataset.max) * dpr)));
    gui.style.width = `${(scale * native) / dpr}px`;
  }
}

let fitQueued = false;
window.addEventListener("resize", () => {  // also fires on browser zoom, which changes the pixel ratio
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitPixels(); });
});

// ---- drawing primitives --------------------------------------------------------

function sprite(gui, name, x, y, w, h) {
  return gui.add(el("img", { src: spriteUrl(name), alt: "" }), x, y, w, h);
}

function rect(gui, x, y, w, h, color) {
  const node = gui.add(el("div"), x, y, w, h);
  node.style.background = color;
  return node;
}

// The enchantment shimmer, cut to the shape of the item.
function glint(gui, url, x, y) {
  const node = gui.add(el("div", { class: "glint" }), x, y, 16, 16);
  node.style.maskImage = `url("${url}")`;
  node.style.webkitMaskImage = `url("${url}")`;
}

export function textWidth(text) {
  let width = 0;
  for (const char of text) width += (glyphWidths[char] ?? 5) + 1;
  return width;
}

// color: one of the pre-tinted glyph sets from build_assets.py
// (white, shadow, green, black, yellow, purple)
function drawText(gui, text, x, y, color) {
  let cursor = x;
  for (const char of text) {
    const width = glyphWidths[char];
    if (width === undefined) { cursor += 6; continue; }
    gui.add(el("img", { src: `${ASSETS}/font/${color}/${char.charCodeAt(0)}.png`, alt: "" }), cursor, y, width, 8);
    cursor += width + 1;
  }
}

function drawShadowText(gui, text, x, y) {
  drawText(gui, text, x + 1, y + 1, "shadow");
  drawText(gui, text, x, y, "white");
}

function fitText(text, max) {
  if (textWidth(text) <= max) return text;
  let cut = text;
  while (cut && textWidth(`${cut}...`) > max) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}...`;
}

function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 42% 46%)`;
}

// One item at slot position (x, y), drawn like the game: icon, glint, count,
// durability bar, plus an invisible button that shows the tooltip.
function drawItem(gui, item, x, y, key) {
  const url = item.id.startsWith("minecraft:") ? itemUrl(item.id) : null;
  const swatch = () => {
    const node = el("div", { class: "swatch" });
    node.style.background = colorFor(item.id);
    return gui.add(node, x + 2, y + 2, 12, 12);
  };

  if (url) {
    const icon = gui.add(el("img", { src: url, alt: "" }), x, y, 16, 16);
    // banners, shields, modded items…: no rendered icon, show a colour swatch
    icon.addEventListener("error", () => icon.replaceWith(swatch()), { once: true });
    if (item.enchanted) glint(gui, url, x, y);
  } else {
    swatch();
  }

  if (item.count > 1) {
    const text = String(item.count);
    drawShadowText(gui, text, x + 19 - 2 - textWidth(text), y + 9);
  }

  if (item.damage && item.max_damage) {
    const left = Math.max(0, (item.max_damage - item.damage) / item.max_damage);
    const width = Math.round(13 - (item.damage * 13) / item.max_damage);
    rect(gui, x + 2, y + 13, 13, 2, "#000000");
    rect(gui, x + 2, y + 13, Math.max(0, width), 1, `hsl(${Math.round(left * 120)} 100% 50%)`);
  }

  const hit = gui.add(el("button", {
    type: "button",
    class: "slot-hit",
    "aria-label": tooltipLines(item).map((line) => line.text).join(", "),
    "data-key": key,
  }), x, y, 16, 16);
  bindTooltip(hit, item);
}

// ---- tooltips ------------------------------------------------------------------

const tooltip = el("div", { class: "tooltip", role: "tooltip", hidden: "" });
document.body.append(tooltip);
let tooltipKey = null;
let tooltipPinned = false;

export const tooltipIsPinned = () => tooltipPinned;

function tooltipLines(item) {
  const lines = [item.name ? { text: item.name, cls: "title custom" } : { text: itemName(item), cls: "title" }];
  for (const enchantment of item.enchantments || []) lines.push({ text: enchantmentName(enchantment), cls: "line" });
  if (item.max_damage) {
    lines.push({ text: `Durability: ${item.max_damage - (item.damage || 0)} / ${item.max_damage}`, cls: "line" });
  }
  return lines;
}

function showTooltip(item, key, anchor) {
  tooltip.replaceChildren(...tooltipLines(item).map((line) => {
    const row = el("div", { class: line.cls, text: line.text });
    if (line.cls.includes("title") && item.enchanted) row.dataset.enchanted = "true";
    return row;
  }));
  tooltip.hidden = false;
  tooltipKey = key;
  if (anchor) {
    const box = anchor.getBoundingClientRect();
    moveTooltip(box.right + 6, box.top - 4);
  }
}

function moveTooltip(x, y) {
  const left = Math.min(x, window.innerWidth - tooltip.offsetWidth - 8);
  const top = Math.min(Math.max(8, y), window.innerHeight - tooltip.offsetHeight - 8);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
  tooltipKey = null;
  tooltipPinned = false;
}

function bindTooltip(button, item) {
  const key = button.dataset.key;
  button.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse") return;
    showTooltip(item, key, null);
    moveTooltip(event.clientX + 12, event.clientY - 16);
  });
  button.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse" && tooltipKey === key && !tooltipPinned) moveTooltip(event.clientX + 12, event.clientY - 16);
  });
  button.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && !tooltipPinned) hideTooltip();
  });
  button.addEventListener("focus", () => showTooltip(item, key, button));
  button.addEventListener("blur", () => { if (!tooltipPinned) hideTooltip(); });
  // taps: pin it until the next tap elsewhere
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (tooltipPinned && tooltipKey === key) { hideTooltip(); return; }
    showTooltip(item, key, button);
    tooltipPinned = true;
  });
}

document.addEventListener("click", () => { if (tooltipPinned) hideTooltip(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideTooltip(); });

// A rebuilt inventory has new slot buttons; move an open tooltip to the new one.
export function reattachTooltip(root) {
  if (!tooltipKey) return;
  const again = root.querySelector(`[data-key="${tooltipKey}"]`);
  if (again) again.dispatchEvent(new Event("focus"));
  else hideTooltip();
}

// ---- the GUIs --------------------------------------------------------------------

// Armor, hearts, hunger and XP exactly as the game stacks them above the hotbar.
// The hotbar itself isn't repeated: the inventory card already has it.
export function vitalsNode(player) {
  const health = Math.ceil(player.health ?? 0);
  const food = player.foodlevel ?? 0;
  const level = player.xplevel ?? 0;
  const armor = player.world?.armor ?? 0;
  const top = armor > 0 ? 10 : 0;
  // about as big relative to the frame as the game draws it at GUI scale 3
  const gui = makeGui(182, top + 15, "vitals", { fill: 0.3, min: 280, max: 3 });
  gui.node.setAttribute("role", "img");
  gui.node.setAttribute("aria-label", [
    `${health / 2} of 10 hearts`, `hunger ${food / 2} of 10`, `level ${level}`,
    armor > 0 ? `armor ${armor / 2} of 10` : null,
  ].filter(Boolean).join(", "));

  const row = (y, value, empty, half, full, fromRight) => {
    for (let i = 0; i < 10; i++) {
      const x = fromRight ? 182 - i * 8 - 9 : i * 8;
      sprite(gui, empty, x, y, 9, 9);
      if (i * 2 + 1 < value) sprite(gui, full, x, y, 9, 9);
      else if (i * 2 + 1 === value) sprite(gui, half, x, y, 9, 9);
    }
  };
  if (armor > 0) row(0, armor, "armor_empty", "armor_half", "armor_full", false);
  row(top, health, "heart_container", "heart_half", "heart_full", false);
  row(top, food, "food_empty", "food_half", "food_full", true);

  sprite(gui, "xp_background", 0, top + 10, 182, 5);
  const progress = Math.min(182, Math.floor((player.xpp ?? 0) * 183));
  if (progress > 0) {
    const clip = gui.add(el("div"), 0, top + 10, progress, 5);
    clip.style.overflow = "hidden";
    const fullBar = el("img", { src: spriteUrl("xp_progress"), alt: "" });
    fullBar.style.cssText = `position:absolute;left:0;top:0;height:100%;width:${(182 / progress) * 100}%`;
    clip.append(fullBar);
  }
  if (level > 0) {
    const text = String(level);
    const x = Math.floor((182 - textWidth(text)) / 2);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) drawText(gui, text, x + dx, top + 4 + dy, "black");
    drawText(gui, text, x, top + 4, "green");
  }
  return gui.node;
}

// The game's advancement toast, for a few minutes after earning one.
export const TOAST_MS = 5 * 60 * 1000;
const TOAST_TITLES = {
  task: ["Advancement Made!", "yellow"],
  goal: ["Goal Reached!", "yellow"],
  challenge: ["Challenge Complete!", "purple"],
};
const toastsShown = new Set();  // slide in once, not on every update

export function toastNode(adv) {
  // same size relative to the frame as the vitals (182 wide at fill .3)
  const gui = makeGui(160, 32, "toast", { fill: (0.3 * 160) / 182, min: (280 * 160) / 182, max: 3 });
  const [heading, color] = TOAST_TITLES[adv.type] || TOAST_TITLES.task;
  gui.node.setAttribute("role", "status");
  gui.node.setAttribute("aria-label", `${heading} ${adv.title}`);
  if (!toastsShown.has(adv.id)) {
    gui.node.dataset.enter = "true";
    toastsShown.add(adv.id);
  }
  sprite(gui, "toast_advancement", 0, 0, 160, 32);
  const url = itemUrl(adv.icon);
  gui.add(el("img", { src: url, alt: "" }), 8, 8, 16, 16);
  if (adv.glint) glint(gui, url, 8, 8);
  drawText(gui, heading, 30, 7, color);
  drawText(gui, fitText(adv.title || "", 125), 30, 18, "white");
  return gui.node;
}

const ARMOR_SLOTS = [["head", "slot_helmet"], ["chest", "slot_chestplate"], ["legs", "slot_leggings"], ["feet", "slot_boots"]];

// The survival inventory screen, slots where the game puts them.
export function inventoryNode(player) {
  const gui = makeGui(176, 166, "inventory");
  gui.node.setAttribute("role", "group");
  gui.node.setAttribute("aria-label", "Inventory");
  sprite(gui, "inventory", 0, 0, 176, 166);

  // your character in the dark preview box, like the game shows it
  if (player.name) {
    const body = gui.add(el("img", {
      class: "preview-body", alt: "",
      src: `https://mc-heads.net/body/${encodeURIComponent(player.name)}/right`,
    }), 26, 10, 49, 66);
    body.addEventListener("error", () => body.remove(), { once: true });
  }

  const armor = player.armor || {};
  ARMOR_SLOTS.forEach(([slot, empty], i) => {
    const y = 8 + i * 18;
    if (armor[slot]) drawItem(gui, armor[slot], 8, y, `armor-${slot}`);
    else sprite(gui, empty, 8, y, 16, 16);
  });
  if (player.offhand) drawItem(gui, player.offhand, 77, 62, "offhand");
  else sprite(gui, "slot_shield", 77, 62, 16, 16);

  for (const item of player.inventory || []) {
    const index = item.slot - 9;
    if (index < 0 || index >= 27) continue;
    drawItem(gui, item, 8 + (index % 9) * 18, 84 + Math.floor(index / 9) * 18, `inv-${item.slot}`);
  }
  for (const item of player.hotbar || []) drawItem(gui, item, 8 + item.slot * 18, 142, `bar-${item.slot}`);
  return gui.node;
}
