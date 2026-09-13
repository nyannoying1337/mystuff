"""Seconds in game per local day.

The game has no per-day numbers, so the agent counts them itself: the time
between two online checks is added to today. One small file; a month is kept,
a week is published.
"""

from __future__ import annotations

import datetime
import json
import time
from pathlib import Path

from common import expand, log, write_json_atomic

DEFAULT_FILE = Path(__file__).with_name("playtime.json")
KEEP_DAYS = 31
PUBLISH_DAYS = 7
# A longer gap between two online checks means the PC slept or the agent was
# stopped; that time isn't counted.
MAX_GAP_SECONDS = 120


def playtime_file(config: dict) -> Path:
    raw = config.get("agent", {}).get("playtime_file")
    return expand(raw) if raw else DEFAULT_FILE


def track(config: dict, state: dict, online: bool, now: float) -> list[dict]:
    """Count the time since the last online check; return the last week, oldest first."""
    path = playtime_file(config)
    history = state.get("playtime")
    if history is None:
        try:
            history = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            history = {}
        if not isinstance(history, dict):
            history = {}
        state["playtime"] = history

    last = state.get("playtime_at")
    state["playtime_at"] = now if online else None
    if online and last is not None and 0 < now - last <= MAX_GAP_SECONDS:
        today = time.strftime("%Y-%m-%d", time.localtime(now))
        history[today] = round(float(history.get(today, 0)) + (now - last), 1)
        for day in sorted(history)[:-KEEP_DAYS]:
            del history[day]
        try:
            write_json_atomic(path, history)
        except OSError as err:
            log.warning("could not save %s: %s", path, err)

    today = datetime.date(*time.localtime(now)[:3])
    return [
        {"date": (day := (today - datetime.timedelta(days=back)).isoformat()), "seconds": int(float(history.get(day, 0)))}
        for back in range(PUBLISH_DAYS - 1, -1, -1)
    ]
