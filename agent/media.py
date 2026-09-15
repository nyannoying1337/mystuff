"""The latest frame of the world, and the 360° panorama of where you logged out."""

from __future__ import annotations

import json
from pathlib import Path

import upload
from common import expand, log, mod_dir, share_server_world, source_type

# A panorama is only "where you logged out" if it was taken shortly before
# (the mod takes one when the pause menu opens, and Save & Quit goes through it).
PANORAMA_MAX_AGE_MS = 10 * 60 * 1000
PANORAMA_QUALITY = 80


def screenshot_path(config: dict) -> Path | None:
    """With the mod, only its own HUD-free frame is published, never F2 shots.
    For a server, screenshot.directory points at a folder to take the newest from."""
    directory = config.get("screenshot", {}).get("directory")
    if directory:
        folder = expand(directory)
        if not folder.is_dir():
            return None
        shots = [p for p in folder.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg"}]
        return max(shots, key=lambda p: p.stat().st_mtime) if shots else None
    if source_type(config) == "mod":
        path = mod_dir(config) / "latest.png"
        return path if path.is_file() else None
    return None


def sync_screenshot(config: dict, state: dict, mode: str | None = None) -> int | None:
    """Upload the frame if it changed; return its time for the status, in ms."""
    # The mod already refuses to capture on a server unless its own switch is on.
    # This is the second lock on the same door: a frame from someone else's world
    # can hold their builds and their nametags.
    if mode == "multiplayer" and not share_server_world(config):
        return None
    path = screenshot_path(config)
    if not path:
        return None
    stamp = path.stat().st_mtime
    if stamp != state.get("last_shot"):
        options = config.get("screenshot", {})
        try:
            image = upload.encode_jpeg(path, int(options.get("quality", 82)), int(options.get("max_width", 1920)))
            upload.push_image(config, "shot", image)
            state["last_shot"] = stamp
            log.info("uploaded screenshot %s (%d kB)", path.name, len(image) // 1024)
        except Exception as err:
            log.warning("screenshot upload failed: %s", err)
    return int(stamp * 1000)


def sync_panorama(config: dict, state: dict, last_seen: dict | None) -> int | None:
    """After a singleplayer logout, upload the panorama taken just before it.
    Returns the panorama's time once it's on the Worker, for the status."""
    # Singleplayer only, and not because of a privacy switch: PanoramaCapture
    # never takes one on a server, so the only thing a looser test could publish
    # is an earlier singleplayer panorama labelled as a server logout.
    if source_type(config) != "mod" or not last_seen or last_seen.get("mode") != "singleplayer":
        return None
    folder = mod_dir(config)
    try:
        taken_at = int(json.loads((folder / "panorama.json").read_text(encoding="utf-8"))["at"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    seen_at = int(last_seen.get("at") or 0)
    # last_seen.at comes from the agent's last online check, up to one push
    # interval before the actual logout, so a slightly later panorama still counts
    if not -60_000 <= seen_at - taken_at <= PANORAMA_MAX_AGE_MS:
        return None  # from an earlier session
    if state.get("panorama_sent") != taken_at:
        try:
            image = upload.encode_jpeg(folder / "panorama.png", PANORAMA_QUALITY)
            upload.push_image(config, "pano", image)
            state["panorama_sent"] = taken_at
            log.info("uploaded panorama (%d kB)", len(image) // 1024)
        except Exception as err:
            log.warning("panorama upload failed: %s", err)
            return None
    return taken_at
