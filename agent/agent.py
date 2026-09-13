#!/usr/bin/env python3
"""Collects machine + Minecraft state and pushes it to the status Worker."""

from __future__ import annotations

import argparse
import io
import json
import logging
import operator
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import tomllib
import uuid
from pathlib import Path

import nbtlib
import requests
from mcrcon import MCRcon
from PIL import Image

import sysinfo

log = logging.getLogger("agent")

# Fields we are willing to publish. Everything else in the NBT is dropped
# rather than filtered, so a Minecraft update can't silently start leaking
# something new.
SAFE_STATS = ("Health", "foodLevel", "XpLevel", "XpP", "Air", "SelectedItemSlot")

# Minecraft usernames. Anything else is refused before it can be spliced into
# an RCON command.
PLAYER_NAME = re.compile(r"^[A-Za-z0-9_]{3,16}$")

# Vanilla max durability per item. NBT only carries it when it was changed from
# the default; regenerate with update_durability.py after a Minecraft update.
MAX_DURABILITY = json.loads((Path(__file__).with_name("max_durability.json")).read_text(encoding="utf-8"))

# What the mod's state.json may contribute to the published payload. Anything
# else in that file (like the local world path) stays on this machine.
PUBLISHED_PLAYER_KEYS = (
    "online", "name", "health", "foodlevel", "xplevel", "xpp", "selecteditemslot",
    "dimension", "position", "rotation", "hotbar", "inventory", "armor", "offhand", "mode",
    "world", "stats", "advancements", "game", "joined_at",
)
# Only known for your own worlds; the mod doesn't write them for servers, and
# they're dropped here too in case an older or newer mod does.
SINGLEPLAYER_ONLY_KEYS = ("position", "rotation", "world", "stats", "advancements")
# Only meaningful while the game is running.
LIVE_ONLY_KEYS = ("game", "joined_at")
# The mod rewrites state.json at least every 5 s; much older means the game is gone.
MOD_STALE_SECONDS = 30

RENDER_SCRIPT = Path(__file__).resolve().parent.parent / "map" / "render.py"

CURSE_CONDITION = re.compile(r"^\s*([a-z_]+)\s*(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)\s*$")
COMPARE = {
    ">=": operator.ge,
    "<=": operator.le,
    ">": operator.gt,
    "<": operator.lt,
    "==": operator.eq,
}


def load_config(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def source_type(config: dict) -> str:
    """"mod" reads the Fabric mod's files (singleplayer); "rcon" asks a server."""
    return config.get("source", {}).get("type", "rcon")


def game_dir(config: dict) -> Path:
    default = "%APPDATA%/.minecraft" if os.name == "nt" else "~/.minecraft"
    raw = config.get("source", {}).get("game_dir", default)
    return Path(os.path.expandvars(raw)).expanduser()


def mod_dir(config: dict) -> Path:
    return game_dir(config) / "mc-status"


def apply_privacy(config: dict, player: dict) -> dict:
    if config.get("privacy", {}).get("hide_coordinates", False) and "position" in player:
        player["position"] = None
        player.pop("rotation", None)
    return player


def unwrap(tag):
    """Turn nbtlib tags into plain Python types."""
    if isinstance(tag, nbtlib.Compound):
        return {key: unwrap(value) for key, value in tag.items()}
    if isinstance(tag, (nbtlib.List, nbtlib.ByteArray, nbtlib.IntArray, nbtlib.LongArray)):
        return [unwrap(item) for item in tag]
    if isinstance(tag, nbtlib.String):
        return str(tag)
    if isinstance(tag, (nbtlib.Float, nbtlib.Double)):
        return float(tag)
    if isinstance(tag, nbtlib.Base):
        return int(tag)
    return tag


def collect_system() -> dict:
    """Live CPU, GPU and memory load, plus temperatures when fastfetch can read them."""
    try:
        system = sysinfo.collect()
    except Exception as err:  # never let a sensor take the whole push down
        log.warning("system info failed: %s", err)
        system = {}
    for key, value in collect_fastfetch().items():
        system.setdefault(key, value)
    return system


def collect_fastfetch() -> dict:
    """Run fastfetch and reduce it to the handful of fields we display."""
    if not shutil.which("fastfetch"):
        return {}

    # Temperatures are only detected when asked for. Older fastfetch builds
    # reject the flags, so fall back to a plain run rather than losing everything.
    modules = None
    for command in (
        ["fastfetch", "--format", "json", "--cpu-temp", "true", "--gpu-temp", "true"],
        ["fastfetch", "--format", "json"],
    ):
        try:
            raw = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=15,
                check=True,
            ).stdout
            modules = json.loads(raw)
            break
        except (subprocess.SubprocessError, json.JSONDecodeError) as err:
            log.warning("fastfetch failed (%s): %s", " ".join(command[3:]) or "plain", err)
    if not isinstance(modules, list):
        return {}

    # fastfetch emits a list of {type, result} objects; index them by type.
    by_type = {}
    for module in modules:
        if isinstance(module, dict) and "type" in module:
            by_type[module["type"]] = module.get("result")

    def text(key):
        value = by_type.get(key)
        if isinstance(value, str):
            return value
        return None

    system = {
        "kernel": text("Kernel"),
        "os": text("OS"),
        "de": text("DE") or text("WM"),
        "uptime": by_type.get("Uptime"),
        "shell": text("Shell"),
    }

    cpu = by_type.get("CPU")
    if isinstance(cpu, dict):
        system["cpu"] = cpu.get("cpu")
        system["cpu_temp"] = cpu.get("temperature")

    gpu = by_type.get("GPU")
    if isinstance(gpu, list) and gpu:
        first = gpu[0]
        if isinstance(first, dict):
            system["gpu"] = first.get("name")
            system["gpu_temp"] = first.get("temperature")

    memory = by_type.get("Memory")
    if isinstance(memory, dict):
        system["mem_used"] = memory.get("used")
        system["mem_total"] = memory.get("total")

    # Local IP and hostname are deliberately never read.
    return {key: value for key, value in system.items() if value is not None}


def parse_player_data(response: str) -> dict | None:
    """Extract the SNBT blob from an RCON `data get entity` response."""
    start = response.find("{")
    if start == -1:
        log.warning("no player data in rcon response: %s", response[:120])
        return None
    try:
        return unwrap(nbtlib.parse_nbt(response[start:]))
    except Exception as err:  # nbtlib raises a variety of parse errors
        log.warning("could not parse player nbt: %s", err)
        return None


def normalise_item(entry: dict) -> dict | None:
    """Flatten one inventory slot across the 1.20.4 and 1.20.5+ NBT shapes."""
    item_id = entry.get("id")
    if not item_id or item_id == "minecraft:air":
        return None

    count = entry.get("count", entry.get("Count", 1))
    slot = entry.get("Slot", -1)

    item = {"id": item_id, "count": int(count), "slot": int(slot)}

    components = entry.get("components") or {}
    legacy = entry.get("tag") or {}

    damage = components.get("minecraft:damage", legacy.get("Damage"))
    max_damage = components.get("minecraft:max_damage") or MAX_DURABILITY.get(item_id)
    if damage:
        item["damage"] = int(damage)
    if max_damage:
        item["max_damage"] = int(max_damage)

    enchanted = bool(
        components.get("minecraft:enchantments")
        or legacy.get("Enchantments")
        or legacy.get("StoredEnchantments")
    )
    if enchanted:
        item["enchanted"] = True

    return item


def read_mod_state(config: dict) -> dict | None:
    path = mod_dir(config) / "state.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as err:
        log.warning("could not read %s: %s", path, err)
        return None
    return data if isinstance(data, dict) else None


def collect_player_mod(config: dict, raw: dict | None) -> dict:
    """The player as the mod last wrote it, reduced to publishable fields."""
    if not raw:
        return {"online": False}
    player = {key: raw[key] for key in PUBLISHED_PLAYER_KEYS if key in raw}
    if not PLAYER_NAME.match(str(player.get("name", ""))):
        log.warning("state.json has no valid player name — reporting offline")
        return {"online": False}
    written_at = raw.get("written_at")
    if player.get("online") and (
        not isinstance(written_at, (int, float)) or time.time() - written_at / 1000 > MOD_STALE_SECONDS
    ):
        player["online"] = False  # game closed or crashed without saying goodbye
    mode = session_mode(raw)
    player["mode"] = mode
    if mode == "multiplayer":
        # where you are on someone's server, and that server's world, aren't yours to publish
        for key in SINGLEPLAYER_ONLY_KEYS:
            player.pop(key, None)
    if not player.get("online"):
        for key in LIVE_ONLY_KEYS:
            player.pop(key, None)
    return apply_privacy(config, player)


def collect_player(config: dict, raw: dict | None = None) -> dict:
    if source_type(config) == "mod":
        return collect_player_mod(config, raw if raw is not None else read_mod_state(config))
    return collect_player_rcon(config)


def collect_player_rcon(config: dict) -> dict:
    rcon_config = config.get("rcon", {})
    player = rcon_config.get("player")
    if not player:
        return {"online": False}
    if not PLAYER_NAME.match(player):
        log.error("rcon.player %r is not a valid Minecraft name", player)
        return {"online": False}

    try:
        with MCRcon(
            rcon_config.get("host", "127.0.0.1"),
            rcon_config["password"],
            port=int(rcon_config.get("port", 25575)),
            timeout=5,
        ) as rcon:
            response = rcon.command(f"data get entity {player}")
    except Exception as err:
        log.info("rcon unavailable (%s) — reporting offline", err)
        return {"online": False}

    data = parse_player_data(response)
    if data is None:
        return {"online": False}

    result: dict = {"online": True, "name": player}

    for key in SAFE_STATS:
        if key in data:
            result[key.lower()] = data[key]

    dimension = data.get("Dimension")
    if dimension:
        result["dimension"] = dimension

    position = data.get("Pos")
    if isinstance(position, list) and len(position) == 3:
        if config.get("privacy", {}).get("hide_coordinates", False):
            result["position"] = None
        else:
            result["position"] = [round(axis, 1) for axis in position]
            rotation = data.get("Rotation")
            if isinstance(rotation, list) and len(rotation) == 2:
                # [yaw, pitch] — only used to point the marker on the map
                result["rotation"] = [round(angle, 1) for angle in rotation]

    inventory = data.get("Inventory")
    if isinstance(inventory, list):
        items = [normalise_item(entry) for entry in inventory if isinstance(entry, dict)]
        items = [item for item in items if item]
        result["hotbar"] = sorted(
            (item for item in items if 0 <= item["slot"] <= 8),
            key=lambda item: item["slot"],
        )
        result["inventory"] = sorted(
            (item for item in items if item["slot"] > 8),
            key=lambda item: item["slot"],
        )
        equipment = data.get("equipment")
        if isinstance(equipment, dict):
            # same shape the mod writes: armor by slot, offhand on its own
            result["armor"] = {
                slot: item
                for slot, value in equipment.items()
                if slot in ("head", "chest", "legs", "feet") and isinstance(value, dict)
                and (item := normalise_item(value))
            }
            offhand = equipment.get("offhand")
            if isinstance(offhand, dict) and (item := normalise_item(offhand)):
                result["offhand"] = item

    return result


def curse_metrics(system: dict, player: dict) -> dict:
    """Numbers a curse rule can test against. Missing sensors are left out, so
    a rule on them simply never fires."""
    metrics = {}
    for key in ("cpu_temp", "gpu_temp", "cpu_percent", "gpu_percent"):
        if isinstance(system.get(key), (int, float)):
            metrics[key] = float(system[key])

    used, total = system.get("mem_used"), system.get("mem_total")
    if isinstance(used, (int, float)) and isinstance(total, (int, float)) and total:
        metrics["mem_percent"] = used / total * 100

    uptime = system.get("uptime")
    if isinstance(uptime, dict) and isinstance(uptime.get("uptime"), (int, float)):
        metrics["uptime_hours"] = uptime["uptime"] / 3_600_000

    for key in ("health", "foodlevel", "xplevel"):
        if isinstance(player.get(key), (int, float)):
            metrics[key] = float(player[key])
    return metrics


def parse_condition(text: str):
    match = CURSE_CONDITION.match(text or "")
    if not match:
        raise ValueError(f"can't read condition {text!r} — expected e.g. 'gpu_temp >= 80'")
    metric, op, threshold = match.groups()
    return metric, COMPARE[op], float(threshold)


def due_curses(config: dict, metrics: dict, state: dict, now: float) -> list[dict]:
    """Rules whose condition holds and whose cooldown has run out."""
    cursed = config.get("cursed", {})
    if not cursed.get("enabled", False):
        return []

    last_fired = state.setdefault("curse_fired", {})
    due = []
    for rule in cursed.get("rules", []):
        name = rule.get("name") or rule.get("when", "unnamed")
        try:
            metric, compare, threshold = parse_condition(rule.get("when", ""))
        except ValueError as err:
            log.warning("curse %r skipped: %s", name, err)
            continue
        if metric not in metrics or not compare(metrics[metric], threshold):
            continue
        cooldown = float(rule.get("cooldown_seconds", 120))
        if name in last_fired and now - last_fired[name] < cooldown:
            continue
        due.append({"name": name, "metric": metric, "value": round(metrics[metric], 1), "rule": rule})
    return due


def queue_mod_commands(config: dict, commands: list[str]) -> Path:
    """Hand commands to the mod, which runs them in the singleplayer world."""
    folder = mod_dir(config) / "commands"
    folder.mkdir(parents=True, exist_ok=True)
    # timestamp first: the mod runs files in name order
    target = folder / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.json"
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps({"commands": commands}), encoding="utf-8")
    os.replace(temp, target)
    return target


def cast_curses(config: dict, player: str, curses: list[dict], state: dict, now: float) -> None:
    """Send each due rule's commands to the server (RCON) or the mod (singleplayer)."""
    try:
        if source_type(config) == "mod":
            for curse in curses:
                commands = [template.replace("{player}", player) for template in curse["rule"].get("commands", [])]
                queue_mod_commands(config, commands)
                log.info("curse %r: queued %d command(s) for the mod", curse["name"], len(commands))
                record_curse(state, curse, now)
            return

        rcon_config = config.get("rcon", {})
        with MCRcon(
            rcon_config.get("host", "127.0.0.1"),
            rcon_config["password"],
            port=int(rcon_config.get("port", 25575)),
            timeout=5,
        ) as rcon:
            for curse in curses:
                for template in curse["rule"].get("commands", []):
                    command = template.replace("{player}", player)
                    reply = rcon.command(command)
                    log.info("curse %r: /%s -> %s", curse["name"], command, reply.strip()[:120] or "ok")
                record_curse(state, curse, now)
    except Exception as err:
        log.warning("could not cast curses: %s", err)


def record_curse(state: dict, curse: dict, now: float) -> None:
    state.setdefault("curse_fired", {})[curse["name"]] = now
    recent = state.setdefault("curse_log", [])
    recent.insert(0, {
        "name": curse["name"],
        "metric": curse["metric"],
        "value": curse["value"],
        "at": int(now * 1000),
    })
    del recent[5:]


# ---------------------------------------------------------------- logout map

def session_mode(raw: dict | None) -> str | None:
    """"singleplayer" or "multiplayer" for the mod's session; None for RCON."""
    if not raw:
        return None
    mode = raw.get("mode")
    if mode in ("singleplayer", "multiplayer"):
        return mode
    # mod 1.0.0 didn't write a mode, but only ever wrote world_path in singleplayer
    return "singleplayer" if raw.get("world_path") else "multiplayer"


def track_presence(config: dict, state: dict, player: dict, raw: dict | None) -> None:
    """Remember where the player was; when they leave a singleplayer world,
    render that spot. Server sessions never touch the map: their coordinates
    belong to someone else's world."""
    mode = session_mode(raw)
    now_ms = int(time.time() * 1000)

    if player.get("online"):
        state["was_online"] = True
        state["session_mode"] = mode
        # always from this session, so a server session can't reuse the last world
        state["world_path"] = raw.get("world_path") if raw and mode == "singleplayer" else None
        if mode == "multiplayer":
            state["last_seen"] = {"mode": "multiplayer", "at": now_ms}
            return
        source = raw if raw else player
        position = source.get("position")
        if isinstance(position, list) and len(position) == 3:
            state["last_seen"] = {
                "position": position,
                "dimension": source.get("dimension"),
                "at": now_ms,
                **({"mode": mode} if mode else {}),
            }
        return

    if state.get("was_online"):
        state["was_online"] = False
        if state.get("session_mode") == "multiplayer":
            log.info("left a multiplayer server — no map render")
        else:
            start_logout_render(config, state)
    elif raw and "last_seen" not in state:
        # Agent started while the player is away (restart, reboot): the mod's
        # last state still says where and when they left.
        at = raw.get("written_at") or now_ms
        if mode == "multiplayer":
            state["last_seen"] = {"mode": "multiplayer", "at": at}
        elif isinstance(raw.get("position"), list):
            state["last_seen"] = {
                "position": raw["position"],
                "dimension": raw.get("dimension"),
                "at": at,
                "mode": "singleplayer",
            }
            state["world_path"] = raw.get("world_path")


def curses_allowed(config: dict, raw: dict | None) -> bool:
    """Curses reach a world over RCON, or through the mod in singleplayer only.
    Queued on a server they'd just wait and fire later in the wrong place."""
    return source_type(config) != "mod" or session_mode(raw) == "singleplayer"


def last_seen_payload(config: dict, state: dict) -> dict | None:
    seen = state.get("last_seen")
    if not seen:
        return None
    payload = dict(seen)
    if config.get("privacy", {}).get("hide_coordinates", False):
        payload["position"] = None
    return payload


def start_logout_render(config: dict, state: dict) -> None:
    map_config = config.get("map", {})
    if not map_config.get("render_on_logout", False):
        return
    world = map_config.get("world") or state.get("world_path")
    seen = state.get("last_seen") or {}
    if not world or not seen.get("position") or not seen.get("dimension"):
        log.info("logout render skipped: no world path or last position known")
        return
    running = state.get("render_thread")
    if running and running.is_alive():
        log.info("logout render skipped: previous render still running")
        return
    thread = threading.Thread(
        target=render_after_save,
        args=(config, Path(world), seen, lambda: state.get("was_online", False)),
        name="map-render",
        daemon=True,
    )
    state["render_thread"] = thread
    thread.start()


def session_lock_released(world: Path) -> bool:
    """Minecraft holds session.lock while the world is open; on Windows the
    lock makes the file unreadable, elsewhere it can't be seen this way."""
    try:
        with (world / "session.lock").open("rb") as handle:
            handle.read(1)
        return True
    except FileNotFoundError:
        return True
    except PermissionError:
        return False


def wait_for_world_saved(world: Path, rejoined, quiet_seconds: float = 5, timeout: float = 180,
                         poll: float = 1.0) -> bool:
    """True once the save looks finished; False if the player came back first."""
    deadline = time.time() + timeout
    level = world / "level.dat"
    while time.time() < deadline:
        if rejoined():
            return False
        try:
            settled = time.time() - level.stat().st_mtime >= quiet_seconds
        except FileNotFoundError:
            settled = True
        if settled and session_lock_released(world):
            return True
        time.sleep(poll)
    log.warning("world %s still looks busy after %ds — rendering anyway", world, timeout)
    return True


def render_command(config: dict, world: Path, seen: dict) -> list[str]:
    map_config = config.get("map", {})
    x, _, z = seen["position"]
    command = [
        sys.executable, str(RENDER_SCRIPT),
        "--world", str(world),
        "--center", str(int(x)), str(int(z)),
        "--radius-chunks", str(int(map_config.get("radius_chunks", 8))),
        "--dimension", seen["dimension"],
        "--live-url", f"{config['worker']['url'].rstrip('/')}/bluemap",
    ]
    if map_config.get("accept_mojang_eula", False):
        command.append("--accept-mojang-eula")
    if map_config.get("java"):
        command += ["--java", str(map_config["java"])]
    if map_config.get("publish", True):
        command.append("--publish")
    return command


def render_after_save(config: dict, world: Path, seen: dict, rejoined) -> None:
    if not wait_for_world_saved(world, rejoined):
        log.info("logout render cancelled: player rejoined")
        return
    command = render_command(config, world, seen)
    log.info("rendering map around %s in %s", seen["position"], seen["dimension"])
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                   encoding="utf-8", errors="replace")
        for line in process.stdout:
            log.info("render: %s", line.rstrip())
        code = process.wait(timeout=30 * 60)
    except (OSError, subprocess.SubprocessError) as err:
        log.warning("map render failed to run: %s", err)
        return
    if code:
        log.warning("map render exited with %d", code)
    else:
        log.info("map render finished")


def newest_screenshot(directory: Path) -> Path | None:
    if not directory.is_dir():
        return None
    shots = [p for p in directory.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg"}]
    if not shots:
        return None
    return max(shots, key=lambda p: p.stat().st_mtime)


def encode_screenshot(path: Path, max_width: int, quality: int) -> bytes:
    with Image.open(path) as image:
        image = image.convert("RGB")
        if image.width > max_width:
            height = round(image.height * max_width / image.width)
            image = image.resize((max_width, height), Image.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=quality, optimize=True)
        return buffer.getvalue()


def push_status(config: dict, payload: dict) -> None:
    endpoint = config["worker"]["url"].rstrip("/")
    response = requests.post(
        f"{endpoint}/status",
        json=payload,
        headers={"Authorization": f"Bearer {config['worker']['token']}"},
        timeout=15,
    )
    response.raise_for_status()


def push_screenshot(config: dict, image: bytes) -> None:
    endpoint = config["worker"]["url"].rstrip("/")
    response = requests.post(
        f"{endpoint}/shot",
        data=image,
        headers={
            "Authorization": f"Bearer {config['worker']['token']}",
            "Content-Type": "image/jpeg",
        },
        timeout=30,
    )
    response.raise_for_status()


def screenshot_directory(config: dict) -> Path | None:
    directory = config.get("screenshot", {}).get("directory")
    if directory:
        return Path(os.path.expandvars(directory)).expanduser()
    # With the mod, only its own HUD-free frames are published — never F2 shots.
    return mod_dir(config) if source_type(config) == "mod" else None


def run_once(config: dict, state: dict) -> bool:
    """Collect and push once. Returns whether the player is in game."""
    raw = read_mod_state(config) if source_type(config) == "mod" else None
    payload = {
        "generated_at": int(time.time() * 1000),
        "system": collect_system(),
        "player": collect_player(config, raw),
    }

    player = payload["player"]
    track_presence(config, state, player, raw)
    if player.get("online"):
        if curses_allowed(config, raw):
            now = time.time()
            curses = due_curses(config, curse_metrics(payload["system"], player), state, now)
            if curses:
                cast_curses(config, player["name"], curses, state, now)
    elif (seen := last_seen_payload(config, state)):
        payload["last_seen"] = seen
    if state.get("curse_log"):
        payload["curses"] = state["curse_log"]

    screenshot_config = config.get("screenshot", {})
    directory = screenshot_directory(config)
    if directory:
        latest = newest_screenshot(directory)
        if latest:
            stamp = latest.stat().st_mtime
            if stamp != state.get("last_shot"):
                try:
                    image = encode_screenshot(
                        latest,
                        int(screenshot_config.get("max_width", 1920)),
                        int(screenshot_config.get("quality", 82)),
                    )
                    push_screenshot(config, image)
                    state["last_shot"] = stamp
                    log.info("uploaded screenshot %s (%d kB)", latest.name, len(image) // 1024)
                except Exception as err:
                    log.warning("screenshot upload failed: %s", err)
            payload["screenshot_at"] = int(stamp * 1000)

    push_status(config, payload)
    player = payload["player"]
    log.info(
        "pushed — player %s, %d items",
        "online" if player.get("online") else "offline",
        len(player.get("hotbar", [])) + len(player.get("inventory", [])),
    )
    return bool(player.get("online"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config.toml", type=Path)
    parser.add_argument("--once", action="store_true", help="collect and push a single time")
    parser.add_argument("--dry-run", action="store_true", help="print the payload, push nothing")
    parser.add_argument("--log-file", type=Path, help="also log here, rotated at 1 MB (for running without a console)")
    args = parser.parse_args()

    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if args.log_file:
        from logging.handlers import RotatingFileHandler
        handlers.append(RotatingFileHandler(args.log_file, maxBytes=1_000_000, backupCount=3, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
    )

    if not args.config.is_file():
        log.error("no config at %s — copy config.example.toml and edit it", args.config)
        return 1

    config = load_config(args.config)

    if args.dry_run:
        raw = read_mod_state(config) if source_type(config) == "mod" else None
        system, player = collect_system(), collect_player(config, raw)
        metrics = curse_metrics(system, player)
        would_fire = [
            {"name": curse["name"], "commands": curse["rule"].get("commands", [])}
            for curse in due_curses(config, metrics, {}, time.time())
        ] if player.get("online") else []
        print(json.dumps(
            {
                "source": source_type(config),
                "mod_dir": str(mod_dir(config)) if source_type(config) == "mod" else None,
                "world_path_for_map": (raw or {}).get("world_path") or config.get("map", {}).get("world"),
                "screenshot_directory": str(screenshot_directory(config)),
                "system": system,
                "player": player,
                "curse_metrics": metrics,
                "curses_that_would_fire": would_fire,
            },
            indent=2,
        ))
        return 0

    agent_config = config.get("agent", {})
    interval = int(agent_config.get("interval_seconds", 10))
    # Nothing changes while you're away, so push rarely — well under the page's
    # 90 s "connection lost" threshold, and easy on the free tiers.
    offline_interval = int(agent_config.get("offline_interval_seconds", 60))
    state: dict = {}

    while True:
        online = False
        try:
            online = run_once(config, state)
        except requests.RequestException as err:
            log.warning("push failed: %s", err)
        except Exception:
            log.exception("unexpected error")

        if args.once:
            return 0
        # While offline, check the mod's file every few seconds so a join is
        # picked up quickly, but only push when the interval is up or you're back.
        if online:
            time.sleep(interval)
            continue
        waited = 0
        while waited < offline_interval:
            time.sleep(min(5, interval))
            waited += min(5, interval)
            if source_type(config) == "mod" and collect_player_mod(config, read_mod_state(config)).get("online"):
                break


if __name__ == "__main__":
    sys.exit(main())
