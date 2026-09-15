"""The player's state: from the Fabric mod's state.json, or from a server over RCON."""

from __future__ import annotations

import json
import time
from pathlib import Path

import nbtlib
from mcrcon import MCRcon

from common import PLAYER_NAME, apply_privacy, log, mod_dir, share_server_world, source_type

# What the mod's state.json may contribute to the published payload. Anything
# else in that file (like the local world path) stays on this machine, and a
# field a future mod adds isn't published until it's listed here.
PUBLISHED_PLAYER_KEYS = (
    "online", "name", "health", "foodlevel", "xplevel", "xpp",
    "dimension", "position", "rotation", "hotbar", "inventory", "armor", "offhand", "mode",
    "world", "stats", "advancements", "game", "joined_at", "last_death", "mods",
)
# Only known for your own worlds; the mod doesn't write them for servers, and
# they're dropped here too in case an older or newer mod does.
SINGLEPLAYER_ONLY_KEYS = ("position", "rotation", "world", "stats", "advancements", "last_death")
# Of those, the ones that are yours to publish if you decide to: where you are
# and where you died. privacy.share_server_world opts into them, and the mod has
# its own matching switch — both have to be on. The rest stay off the table:
# a server's world data isn't yours, and statistics and advancements aren't even
# readable client-side on a server (see Progress.java).
SERVER_SHAREABLE_KEYS = ("position", "rotation", "last_death")
# Only meaningful while the game is running.
LIVE_ONLY_KEYS = ("game", "joined_at")
# The mod rewrites state.json at least every 5 s; much older means the game is gone.
MOD_STALE_SECONDS = 30

# RCON: the NBT fields we read. Everything else is dropped rather than filtered,
# so a Minecraft update can't silently start leaking something new.
SAFE_STATS = ("Health", "foodLevel", "XpLevel", "XpP")

# Vanilla max durability per item. NBT only carries it when it was changed from
# the default; regenerate with update_durability.py after a Minecraft update.
MAX_DURABILITY = json.loads(Path(__file__).with_name("max_durability.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------- the mod

def read_mod_state(config: dict) -> dict | None:
    path = mod_dir(config) / "state.json"
    for attempt in (1, 2):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError) as err:
            # the mod swaps the file in every second or so; a second look usually works
            if attempt == 2:
                log.warning("could not read %s: %s", path, err)
                return None
            time.sleep(0.05)
    return None


def session_mode(raw: dict | None) -> str | None:
    """"singleplayer" or "multiplayer" for the mod's session; None without one."""
    if not raw:
        return None
    return "singleplayer" if raw.get("mode") == "singleplayer" else "multiplayer"


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
    player["mode"] = session_mode(raw)
    if player["mode"] == "multiplayer":
        # where you are on someone's server, and that server's world, aren't yours to publish
        shared = SERVER_SHAREABLE_KEYS if share_server_world(config) else ()
        for key in SINGLEPLAYER_ONLY_KEYS:
            if key not in shared:
                player.pop(key, None)
    if not player.get("online"):
        for key in LIVE_ONLY_KEYS:
            player.pop(key, None)
    return apply_privacy(config, player)


def collect_player(config: dict, raw: dict | None = None) -> dict:
    if source_type(config) == "mod":
        return collect_player_mod(config, raw if raw is not None else read_mod_state(config))
    return collect_player_rcon(config)


# ---------------------------------------------------------------- RCON

def open_rcon(config: dict) -> MCRcon:
    rcon = config.get("rcon", {})
    return MCRcon(rcon.get("host", "127.0.0.1"), rcon["password"], port=int(rcon.get("port", 25575)), timeout=5)


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
    """One inventory slot from 1.20.5+ NBT, in the shape the mod writes."""
    item_id = entry.get("id")
    if not item_id or item_id == "minecraft:air":
        return None
    item = {"id": item_id, "count": int(entry.get("count", 1)), "slot": int(entry.get("Slot", -1))}
    components = entry.get("components") or {}
    damage = components.get("minecraft:damage")
    max_damage = components.get("minecraft:max_damage") or MAX_DURABILITY.get(item_id)
    if damage:
        item["damage"] = int(damage)
    if max_damage:
        item["max_damage"] = int(max_damage)
    if components.get("minecraft:enchantments") or components.get("minecraft:stored_enchantments"):
        item["enchanted"] = True
    return item


def collect_player_rcon(config: dict) -> dict:
    player = config.get("rcon", {}).get("player")
    if not player:
        return {"online": False}
    if not PLAYER_NAME.match(player):
        log.error("rcon.player %r is not a valid Minecraft name", player)
        return {"online": False}

    try:
        with open_rcon(config) as rcon:
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
    if data.get("Dimension"):
        result["dimension"] = data["Dimension"]

    position = data.get("Pos")
    if isinstance(position, list) and len(position) == 3:
        result["position"] = [round(axis, 1) for axis in position]
        rotation = data.get("Rotation")
        if isinstance(rotation, list) and len(rotation) == 2:
            # [yaw, pitch]: only used to point the marker on the map
            result["rotation"] = [round(angle, 1) for angle in rotation]

    inventory = data.get("Inventory")
    if isinstance(inventory, list):
        items = [item for entry in inventory if isinstance(entry, dict) and (item := normalise_item(entry))]
        result["hotbar"] = sorted((item for item in items if 0 <= item["slot"] <= 8), key=lambda item: item["slot"])
        result["inventory"] = sorted((item for item in items if item["slot"] > 8), key=lambda item: item["slot"])
    equipment = data.get("equipment")
    if isinstance(equipment, dict):
        result["armor"] = {
            slot: item for slot, value in equipment.items()
            if slot in ("head", "chest", "legs", "feet") and isinstance(value, dict) and (item := normalise_item(value))
        }
        offhand = equipment.get("offhand")
        if isinstance(offhand, dict) and (item := normalise_item(offhand)):
            result["offhand"] = item

    return apply_privacy(config, result)
