#!/usr/bin/env python3
"""Collects machine and Minecraft state and pushes it to the status Worker.

Modules:
  collect   the player, from the Fabric mod's state.json or a server over RCON
  presence  last seen, and the map render after leaving a world
  media     the latest frame and the logout panorama
  playtime  time in game per day
  cursed    cursed-mode rules
  sysinfo   CPU, GPU and memory load
  upload    requests to the Worker
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

import requests

import collect
import cursed
import events
import media
import playtime
import presence
import sysinfo
import upload
from common import load_config, log, mod_dir, source_type


def run_once(config: dict, state: dict) -> bool:
    """Collect and push once. Returns whether the player is in game."""
    raw = collect.read_mod_state(config) if source_type(config) == "mod" else None
    mode = collect.session_mode(raw)
    now = time.time()
    payload = {
        "generated_at": int(now * 1000),
        "system": sysinfo.collect_safely(),
        "player": collect.collect_player(config, raw),
    }
    player = payload["player"]
    online = bool(player.get("online"))

    presence.track(config, state, player, raw, mode)
    payload["playtime"] = playtime.track(config, state, online, now)
    payload["events"] = events.track(config, state, player, mode, now)

    if online:
        if cursed.allowed(config, raw):
            due = cursed.due(config, cursed.metrics(payload["system"], player), state, now)
            if due:
                cursed.cast(config, player["name"], due, state, now)
    else:
        seen = presence.last_seen_payload(config, state)
        if seen:
            payload["last_seen"] = seen
            if (panorama_at := media.sync_panorama(config, state, seen)):
                payload["panorama_at"] = panorama_at
    if state.get("curse_log"):
        payload["curses"] = state["curse_log"]
    if (shot_at := media.sync_screenshot(config, state)):
        payload["screenshot_at"] = shot_at

    upload.push_status(config, payload)
    log.info("pushed — player %s, %d items", "online" if online else "offline",
             len(player.get("hotbar", [])) + len(player.get("inventory", [])))
    return online


def dry_run(config: dict) -> None:
    raw = collect.read_mod_state(config) if source_type(config) == "mod" else None
    system, player = sysinfo.collect_safely(), collect.collect_player(config, raw)
    metrics = cursed.metrics(system, player)
    would_fire = [
        {"name": curse["name"], "commands": curse["rule"].get("commands", [])}
        for curse in cursed.due(config, metrics, {}, time.time())
    ] if player.get("online") else []
    print(json.dumps({
        "source": source_type(config),
        "mod_dir": str(mod_dir(config)) if source_type(config) == "mod" else None,
        "world_path_for_map": (raw or {}).get("world_path") or config.get("map", {}).get("world"),
        "screenshot": str(media.screenshot_path(config)),
        "system": system,
        "player": player,
        "curse_metrics": metrics,
        "curses_that_would_fire": would_fire,
    }, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=Path(__file__).with_name("config.toml"), type=Path)
    parser.add_argument("--once", action="store_true", help="collect and push a single time")
    parser.add_argument("--dry-run", action="store_true", help="print the payload, push nothing")
    parser.add_argument("--log-file", type=Path, help="also log here, rotated at 1 MB (for running without a console)")
    args = parser.parse_args()

    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if args.log_file:
        handlers.append(RotatingFileHandler(args.log_file, maxBytes=1_000_000, backupCount=3, encoding="utf-8"))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        datefmt="%H:%M:%S", handlers=handlers)

    if not args.config.is_file():
        log.error("no config at %s — run setup.py, or copy config.example.toml and edit it", args.config)
        return 1
    config = load_config(args.config)

    if args.dry_run:
        dry_run(config)
        return 0

    agent_config = config.get("agent", {})
    interval = int(agent_config.get("interval_seconds", 10))
    # Nothing changes while you're away, so push rarely: well under the page's
    # 90 s "quiet" threshold, and easy on the free tiers.
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
        if online:
            time.sleep(interval)
            continue
        # While offline, look at the mod's file every few seconds so a join is
        # picked up quickly, but only push when the interval is up or you're back.
        step = min(5, interval)
        for _ in range(max(1, offline_interval // step)):
            time.sleep(step)
            if source_type(config) == "mod" and collect.collect_player_mod(config, collect.read_mod_state(config)).get("online"):
                break


if __name__ == "__main__":
    sys.exit(main())
