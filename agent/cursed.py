"""Cursed mode: rules that run commands in your world when the machine is struggling.

(Not "curses.py": that name belongs to Python's standard library.)
"""

from __future__ import annotations

import operator
import re
import time
import uuid

import collect
from common import log, mod_dir, source_type, write_json_atomic

CONDITION = re.compile(r"^\s*([a-z_]+)\s*(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)\s*$")
COMPARE = {">=": operator.ge, "<=": operator.le, ">": operator.gt, "<": operator.lt, "==": operator.eq}
RECENT = 5


def metrics(system: dict, player: dict) -> dict:
    """Numbers a rule can test against. Missing sensors are left out, so a rule
    on them simply never fires."""
    values = {}
    for key in ("cpu_temp", "gpu_temp", "cpu_percent", "gpu_percent"):
        if isinstance(system.get(key), (int, float)):
            values[key] = float(system[key])
    used, total = system.get("mem_used"), system.get("mem_total")
    if isinstance(used, (int, float)) and isinstance(total, (int, float)) and total:
        values["mem_percent"] = used / total * 100
    if isinstance(system.get("uptime_seconds"), (int, float)):
        values["uptime_hours"] = system["uptime_seconds"] / 3600
    for key in ("health", "foodlevel", "xplevel"):
        if isinstance(player.get(key), (int, float)):
            values[key] = float(player[key])
    return values


def parse_condition(text: str):
    match = CONDITION.match(text or "")
    if not match:
        raise ValueError(f"can't read condition {text!r}: expected e.g. 'gpu_percent >= 95'")
    metric, op, threshold = match.groups()
    return metric, COMPARE[op], float(threshold)


def allowed(config: dict, raw: dict | None) -> bool:
    """Curses reach a world over RCON, or through the mod in singleplayer only.
    Queued on a server they'd just wait and fire later in the wrong place."""
    return source_type(config) != "mod" or collect.session_mode(raw) == "singleplayer"


def due(config: dict, values: dict, state: dict, now: float) -> list[dict]:
    """Rules whose condition holds and whose cooldown has run out."""
    cursed = config.get("cursed", {})
    if not cursed.get("enabled", False):
        return []
    last_fired = state.setdefault("curse_fired", {})
    ready = []
    for rule in cursed.get("rules", []):
        name = rule.get("name") or rule.get("when", "unnamed")
        try:
            metric, compare, threshold = parse_condition(rule.get("when", ""))
        except ValueError as err:
            log.warning("curse %r skipped: %s", name, err)
            continue
        if metric not in values or not compare(values[metric], threshold):
            continue
        if name in last_fired and now - last_fired[name] < float(rule.get("cooldown_seconds", 120)):
            continue
        ready.append({"name": name, "metric": metric, "value": round(values[metric], 1), "rule": rule})
    return ready


def queue_mod_commands(config: dict, commands: list[str]):
    """Hand commands to the mod, which runs them in the singleplayer world."""
    folder = mod_dir(config) / "commands"
    folder.mkdir(parents=True, exist_ok=True)
    # timestamp first: the mod runs files in name order
    target = folder / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.json"
    write_json_atomic(target, {"commands": commands})
    return target


def cast(config: dict, player: str, curses: list[dict], state: dict, now: float) -> None:
    """Send each due rule's commands to the mod (singleplayer) or the server (RCON)."""
    def commands(curse):
        return [template.replace("{player}", player) for template in curse["rule"].get("commands", [])]

    try:
        if source_type(config) == "mod":
            for curse in curses:
                queue_mod_commands(config, commands(curse))
                log.info("curse %r: queued %d command(s) for the mod", curse["name"], len(commands(curse)))
                record(state, curse, now)
            return
        with collect.open_rcon(config) as rcon:
            for curse in curses:
                for command in commands(curse):
                    reply = rcon.command(command)
                    log.info("curse %r: /%s -> %s", curse["name"], command, reply.strip()[:120] or "ok")
                record(state, curse, now)
    except Exception as err:
        log.warning("could not cast curses: %s", err)


def record(state: dict, curse: dict, now: float) -> None:
    state.setdefault("curse_fired", {})[curse["name"]] = now
    recent = state.setdefault("curse_log", [])
    recent.insert(0, {"name": curse["name"], "metric": curse["metric"], "value": curse["value"], "at": int(now * 1000)})
    del recent[RECENT:]
