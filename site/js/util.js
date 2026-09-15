// Small helpers shared by every module: DOM building and number formatting.

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

const numberFormat = new Intl.NumberFormat("en-US");
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const plainNumber = (n) => numberFormat.format(n ?? 0);
export const count = (n) => (n >= 100000 ? compactFormat.format(n) : numberFormat.format(n ?? 0));
export const gib = (bytes) => `${(bytes / 2 ** 30).toFixed(bytes >= 10 * 2 ** 30 ? 0 : 1)} GB`;
export const shortId = (id) => (id || "").replace(/^minecraft:/, "");
export const titleCase = (text) => text.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

export function distance(cm) {
  const m = (cm || 0) / 100;
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 100000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

export function timeAgo(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

// Wall-clock HH:MM in the viewer's timezone, for timeline entries.
export const timeOfDay = (ms) => {
  const when = new Date(ms);
  return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
};

// 0 ticks = 6:00 in the game's day
export function clockTime(ticks) {
  const minutes = Math.floor((((ticks + 6000) % 24000) / 1000) * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export const dimensionName = (id) =>
  ({ overworld: "Overworld", the_nether: "The Nether", the_end: "The End" })[shortId(id)] || titleCase(shortId(id));
