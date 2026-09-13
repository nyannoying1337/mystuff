#!/usr/bin/env python3
"""Collects machine + Minecraft state and pushes it to the status Worker."""

from __future__ import annotations

import argparse
import io
import json
import logging
import operator
import re
import shutil
import subprocess
import sys
import time
import tomllib
from pathlib import Path

import nbtlib
import requests
from mcrcon import MCRcon
from PIL import Image

log = logging.getLogger("agent")

# Fields we are willing to publish. Everything else in the NBT is dropped
# rather than filtered, so a Minecraft update can't silently start leaking
# something new.
SAFE_STATS = ("Health", "foodLevel", "XpLevel", "XpP", "Air", "SelectedItemSlot")

# Minecraft usernames. Anything else is refused before it can be spliced into
# an RCON command.
PLAYER_NAME = re.compile(r"^[A-Za-z0-9_]{3,16}$")

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
    max_damage = components.get("minecraft:max_damage")
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


def collect_player(config: dict) -> dict:
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
        armor = data.get("equipment")
        if isinstance(armor, dict):
            result["equipment"] = {
                slot: normalise_item(value)
                for slot, value in armor.items()
                if isinstance(value, dict)
            }

    return result


def curse_metrics(system: dict, player: dict) -> dict:
    """Numbers a curse rule can test against. Missing sensors are left out, so
    a rule on them simply never fires."""
    metrics = {}
    for key in ("cpu_temp", "gpu_temp"):
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


def cast_curses(config: dict, player: str, curses: list[dict], state: dict, now: float) -> None:
    """Send each due rule's commands over one RCON connection."""
    rcon_config = config.get("rcon", {})
    try:
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
                state["curse_fired"][curse["name"]] = now
                recent = state.setdefault("curse_log", [])
                recent.insert(0, {
                    "name": curse["name"],
                    "metric": curse["metric"],
                    "value": curse["value"],
                    "at": int(now * 1000),
                })
                del recent[5:]
    except Exception as err:
        log.warning("could not cast curses: %s", err)


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


def run_once(config: dict, state: dict) -> None:
    payload = {
        "generated_at": int(time.time() * 1000),
        "system": collect_system(),
        "player": collect_player(config),
    }

    player = payload["player"]
    if player.get("online"):
        now = time.time()
        curses = due_curses(config, curse_metrics(payload["system"], player), state, now)
        if curses:
            cast_curses(config, player["name"], curses, state, now)
    if state.get("curse_log"):
        payload["curses"] = state["curse_log"]

    screenshot_config = config.get("screenshot", {})
    directory = screenshot_config.get("directory")
    if directory:
        latest = newest_screenshot(Path(directory).expanduser())
        if latest:
            stamp = latest.stat().st_mtime
            if stamp != state.get("last_shot"):
                try:
                    image = encode_screenshot(
                        latest,
                        int(screenshot_config.get("max_width", 1280)),
                        int(screenshot_config.get("quality", 78)),
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
        "pushed — player %s, %d hotbar items",
        "online" if player.get("online") else "offline",
        len(player.get("hotbar", [])),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config.toml", type=Path)
    parser.add_argument("--once", action="store_true", help="collect and push a single time")
    parser.add_argument("--dry-run", action="store_true", help="print the payload, push nothing")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    if not args.config.is_file():
        log.error("no config at %s — copy config.example.toml and edit it", args.config)
        return 1

    config = load_config(args.config)

    if args.dry_run:
        system, player = collect_system(), collect_player(config)
        metrics = curse_metrics(system, player)
        would_fire = [
            {"name": curse["name"], "commands": curse["rule"].get("commands", [])}
            for curse in due_curses(config, metrics, {}, time.time())
        ] if player.get("online") else []
        print(json.dumps(
            {
                "system": system,
                "player": player,
                "curse_metrics": metrics,
                "curses_that_would_fire": would_fire,
            },
            indent=2,
        ))
        return 0

    interval = int(config.get("agent", {}).get("interval_seconds", 20))
    state: dict = {}

    while True:
        try:
            run_once(config, state)
        except requests.RequestException as err:
            log.warning("push failed: %s", err)
        except Exception:
            log.exception("unexpected error")

        if args.once:
            return 0
        time.sleep(interval)


if __name__ == "__main__":
    sys.exit(main())
