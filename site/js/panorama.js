// A 360° view from the mod's panorama: one 6×1 strip of 90° faces (front,
// right, back, left, up, down), the same layout as vanilla panoramas. Drawn as
// a CSS 3D cube around the camera, so no WebGL or library is needed.
import { el } from "./util.js";

const FACE = 1024;  // CSS size of a face; keep in sync with .pano-face in style.css
// Where each face sits around the viewer, looking down -z with y pointing down.
const FACE_TRANSFORMS = [
  "translateZ(-512px)",                        // front
  "rotateY(-90deg) translateZ(-512px)",        // right
  "rotateY(180deg) translateZ(-512px)",        // back
  "rotateY(90deg) translateZ(-512px)",         // left
  "rotateX(-90deg) translateZ(-512px)",        // up: image top is behind you
  "rotateX(90deg) translateZ(-512px)",         // down: image top is in front
];
const IDLE_BEFORE_TURNING_MS = 5000;
const TURN_DEGREES_PER_SECOND = 4;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

export function panoramaView(url) {
  const cube = el("div", { class: "pano-cube" });
  FACE_TRANSFORMS.forEach((transform, index) => {
    const face = el("div", { class: "pano-face" });
    face.style.backgroundImage = `url("${url}")`;
    face.style.backgroundPosition = `${(index / 5) * 100}% 0`;
    // a hair larger than the cube, so no seams show between faces
    face.style.transform = `${transform} scale(${(FACE + 2) / FACE})`;
    cube.append(face);
  });
  const root = el("div", {
    class: "pano", role: "img", tabindex: "0",
    "aria-label": "A 360° view of where they logged out. Drag or use the arrow keys to look around.",
  }, [cube]);

  let yaw = 0;       // degrees, positive looks right
  let pitch = 0;     // degrees, positive looks up
  let fov = 90;      // horizontal field of view
  let lastInput = -Infinity;
  let frame = 0;
  let previous = 0;

  function draw() {
    const width = root.clientWidth || 1;
    const focal = width / 2 / Math.tan((fov * Math.PI) / 360);
    root.style.perspective = `${focal}px`;
    cube.style.transform = `translateZ(${focal}px) rotateX(${pitch}deg) rotateY(${yaw}deg)`;
  }

  function look(dYaw, dPitch) {
    yaw = (yaw + dYaw) % 360;
    pitch = Math.max(-89, Math.min(89, pitch + dPitch));
    lastInput = performance.now();
    draw();
  }

  // drag to look; the view follows the pointer like grabbing the world
  const pointers = new Map();
  root.addEventListener("pointerdown", (event) => {
    try {
      root.setPointerCapture(event.pointerId);  // keep dragging when the pointer leaves the view
    } catch { /* not a real pointer (synthetic events) */ }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    lastInput = performance.now();
  });
  root.addEventListener("pointermove", (event) => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const degreesPerPixel = fov / (root.clientWidth || 1);
    if (pointers.size === 2) {
      // pinch: zoom by the change in distance between the two fingers
      const [a, b] = [...pointers.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const [c, d] = [...pointers.values()];
      zoom((before - Math.hypot(c.x - d.x, c.y - d.y)) * 0.15);
      return;
    }
    look(-(event.clientX - last.x) * degreesPerPixel, (event.clientY - last.y) * degreesPerPixel);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });
  const release = (event) => pointers.delete(event.pointerId);
  root.addEventListener("pointerup", release);
  root.addEventListener("pointercancel", release);

  function zoom(delta) {
    fov = Math.max(45, Math.min(110, fov + delta));
    lastInput = performance.now();
    draw();
  }
  root.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom(event.deltaY * 0.05);
  }, { passive: false });

  root.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 10], ArrowDown: [0, -10] }[event.key];
    if (!step) return;
    event.preventDefault();
    look(...step);
  });

  // Turns slowly on its own once nobody has touched it for a bit; only while
  // it's on screen, the tab is visible, and motion isn't reduced.
  let visible = false;
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) start();
  }).observe(root);

  function tick(now) {
    frame = 0;
    if (!visible || document.hidden || !root.isConnected) return;
    const seconds = Math.min(0.1, (now - previous) / 1000);
    previous = now;
    if (!reducedMotion.matches && now - lastInput > IDLE_BEFORE_TURNING_MS && pointers.size === 0) {
      yaw = (yaw + TURN_DEGREES_PER_SECOND * seconds) % 360;
      pitch *= 1 - Math.min(1, seconds);  // drift back to the horizon
      draw();
    }
    frame = requestAnimationFrame(tick);
  }
  function start() {
    if (frame) return;
    previous = performance.now();
    frame = requestAnimationFrame(tick);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && visible) start(); });
  new ResizeObserver(draw).observe(root);

  draw();
  return root;
}
