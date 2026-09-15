// The frame archive: a scrubber over the last few days, published to the repo's
// `shots` branch by agent/archive.py and served from /shots.
import { dimensionName, el, timeOfDay } from "./util.js";

export const SHOTS = "shots";

// Absent branch, absent index, a deploy without it: all mean the same thing to
// the page, which is that there is no archive to show.
export async function loadShots() {
  try {
    const response = await fetch(`${SHOTS}/index.json`, { cache: "no-cache" });
    if (!response.ok) return null;
    const data = await response.json();
    const frames = Array.isArray(data.frames) ? data.frames.filter((frame) => frame && frame.file) : [];
    return frames.length ? { frames, panoramas: data.panoramas || {}, base: SHOTS } : null;
  } catch {
    return null;
  }
}

// archive.py names day folders by local date and the file path carries that name, so
// read it from the path rather than recomputing it in UTC. A frame may also say so
// outright, which is how demo frames — whose paths aren't dated — get a day.
const dayOf = (frame) => frame.day || String(frame.file || "").slice(0, 10);

function caption(frame) {
  const when = new Date(frame.at);
  const date = when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const parts = [`${date} · ${timeOfDay(frame.at)}`];
  if (frame.dimension) parts.push(dimensionName(frame.dimension));
  if (Array.isArray(frame.position) && frame.position.length === 3) {
    const [x, y, z] = frame.position;
    parts.push(`X ${x} Y ${y} Z ${z}`);
  }
  return parts.join(" · ");
}

export function shotsView({ frames, panoramas, base = SHOTS }) {
  let current = frames.length - 1;
  // Published frames sit under shots/; demo mode serves its own from elsewhere.
  const src = (path) => (/^(?:data:|https?:)/.test(path) ? path : `${base}/${path}`);

  const image = el("img", { class: "shot-image", alt: "", loading: "lazy" });
  const text = el("p", { class: "shot-caption" });
  const slider = el("input", {
    class: "shot-slider", type: "range", id: "shot-slider",
    min: "0", max: String(frames.length - 1), value: String(current),
    "aria-label": "Move through the archived frames",
  });
  const strip = el("div", { class: "shot-strip" });

  const thumbs = frames.map((frame, at) => {
    const thumb = el("img", {
      class: "shot-thumb", src: src(frame.thumb || frame.file), alt: "",
      loading: "lazy", "data-at": String(at),
    });
    thumb.addEventListener("click", () => show(at));
    return thumb;
  });
  strip.append(...thumbs);

  const panoLink = el("a", { class: "btn shot-pano", href: "#", text: "360° from this day" });
  panoLink.hidden = true;

  // Dragging fires input continuously. The caption and the strip can follow every
  // step for free; the full-size picture waits for the drag to settle, or one
  // sweep of a long archive would ask for hundreds of 1280 px frames.
  let pending = 0;
  function showImage(frame) {
    clearTimeout(pending);
    pending = setTimeout(() => { image.src = src(frame.file); }, 120);
  }

  function show(at) {
    current = Math.max(0, Math.min(frames.length - 1, at));
    const frame = frames[current];
    showImage(frame);
    text.textContent = caption(frame);
    slider.value = String(current);
    for (const thumb of thumbs) thumb.classList.toggle("is-current", thumb.dataset.at === String(current));
    thumbs[current]?.scrollIntoView({ block: "nearest", inline: "center" });

    const panorama = panoramas[dayOf(frame)];
    panoLink.hidden = !panorama;
    if (panorama) panoLink.href = src(panorama);
  }

  slider.addEventListener("input", () => show(Number(slider.value)));
  // and immediately once the drag ends, so releasing never leaves it waiting
  slider.addEventListener("change", () => {
    clearTimeout(pending);
    image.src = src(frames[current].file);
  });
  image.addEventListener("click", () => window.open(image.src, "_blank", "noopener"));

  show(current);
  return { node: el("div", { class: "shots" }, [image, text, slider, strip, panoLink]), show };
}
