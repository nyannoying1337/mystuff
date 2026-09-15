// Game textures and English names, built at deploy time by site/build_assets.py
// from Minecraft's client jar. Nothing from the game is committed to the repo.
import { isVanilla, shortId, titleCase } from "./util.js";

export const ASSETS = "assets/mc";

// Glyph widths for the game font; false when the assets weren't built, in which
// case the page falls back to plain text.
export let glyphWidths = null;
export let names = { items: {}, enchantments: {}, levels: {}, biomes: {}, entities: {} };

export const assetsReady = Promise.all([
  fetch(`${ASSETS}/font/widths.json`).then((r) => (r.ok ? r.json() : false)).catch(() => false),
  fetch(`${ASSETS}/names.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
]).then(([widths, loadedNames]) => {
  glyphWidths = widths;
  if (loadedNames) names = { ...names, ...loadedNames };
});

// Only vanilla textures are built into assets/mc, and a modded id can collide
// with a vanilla path ("create:copper_block"), which would show a confidently
// wrong icon. Modded items get the barrier placeholder and keep their real name.
export const itemUrl = (id) => `${ASSETS}/item/${isVanilla(id) ? shortId(id) : "barrier"}.png`;
// Only the layers a stack's own colour applies to — a potion's brew, leather's dye.
// build_assets.py writes one of these beside the icon for the few items that take one.
// null for a modded id, for the same reason itemUrl sends one to the barrier: a modded
// path can collide with a vanilla one and tint confidently the wrong shape.
export const itemTintUrl = (id) => (isVanilla(id) ? `${ASSETS}/item/${shortId(id)}.tint.png` : null);
export const spriteUrl = (name) => `${ASSETS}/hud/${name}.png`;

export function itemName(item) {
  const short = shortId(item.id);
  return names.items[short] || short.replace(/_/g, " ");
}

// Enchantments that only have one level; the game shows them without "I".
const SINGLE_LEVEL = new Set([
  "mending", "silk_touch", "infinity", "flame", "channeling", "multishot",
  "aqua_affinity", "binding_curse", "vanishing_curse",
]);

export function enchantmentName(enchantment) {
  const short = shortId(enchantment.id);
  const name = names.enchantments[short] || short.replace(/_/g, " ");
  if (SINGLE_LEVEL.has(short) && enchantment.level === 1) return name;
  return `${name} ${names.levels[String(enchantment.level)] || enchantment.level}`;
}

export const biomeName = (id) => names.biomes[shortId(id)] || titleCase(shortId(id));
export const entityName = (id) => names.entities[shortId(id)] || titleCase(shortId(id));
