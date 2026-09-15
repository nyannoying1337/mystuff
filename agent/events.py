"""What happened, and when: the day's timeline for the status page.

The statistics panel shows what is true now; this shows what happened. Anything
that can't be given a timestamp belongs there instead — which is why blocks
mined isn't here, and why the only counters tracked are ones whose crossing is
itself the moment.

One small file beside playtime.json: ten days are kept, the last day published.
Nothing is read that the payload doesn't already carry, so a server session
records that it happened without recording anything about the server.
"""

from __future__ import annotations

import datetime
import json
import time
from pathlib import Path

from common import expand, log, write_json_atomic

DEFAULT_FILE = Path(__file__).with_name("events.json")
KEEP_DAYS = 10
PUBLISH_DAYS = 1
# A longer gap between two checks means the PC slept or the agent was stopped.
# The session is closed where it was last seen rather than reported as one
# enormous sitting — the same guard playtime.py uses for the same reason.
# It's a floor, not a fixed value: interval_seconds is configurable, and a slow
# poller would otherwise see every one of its own ticks as a gap and split the
# session on each.
MAX_GAP_SECONDS = 120
# A session seen only once — the agent started and stopped around it, or the
# game was open for a moment — isn't worth two lines. Both are dropped.
MIN_SESSION_SECONDS = 60

# Milestones sit on powers of ten, so each lands a handful of times ever.
MARKS: dict[str, tuple[int, ...]] = {
    "kills": (100, 1_000, 10_000, 100_000),
    "km": (10, 100, 1_000),
    "hours": (10, 100, 1_000),
}
MARK_TEXT = {
    "kills": ("{value:,} mobs defeated", "minecraft:iron_sword"),
    "km": ("{value:,} km travelled", "minecraft:leather_boots"),
    "hours": ("{value:,} hours played", "minecraft:clock"),
}

DIMENSIONS = {
    "minecraft:overworld": ("the Overworld", "minecraft:grass_block"),
    "minecraft:the_nether": ("the Nether", "minecraft:netherrack"),
    "minecraft:the_end": ("the End", "minecraft:end_stone"),
}


def events_file(config: dict) -> Path:
    raw = config.get("agent", {}).get("events_file")
    return expand(raw) if raw else DEFAULT_FILE


def track(config: dict, state: dict, player: dict, mode: str | None, now: float) -> list[dict]:
    """Record what changed since the last check; return the events to publish."""
    path = events_file(config)
    history = _history(state, path)
    before = json.dumps(history, sort_keys=True)

    online = bool(player.get("online"))
    _session(history, now, online, mode, _gap_limit(config))
    if online:
        _dimension(history, player, now)
        _advancements(history, player, now)
        stats = player.get("stats") or {}
        if stats:
            _deaths(history, stats, now)
            _milestones(history, stats, now)

    if json.dumps(history, sort_keys=True) != before:
        try:
            write_json_atomic(path, history)
        except OSError as err:
            log.warning("could not save %s: %s", path, err)
    return _publish(history, now)


# ---------------------------------------------------------------- the file


def _history(state: dict, path: Path) -> dict:
    history = state.get("events")
    if history is None:
        try:
            history = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            history = {}
        if not isinstance(history, dict):
            history = {}
        for key in ("days", "marks", "seen"):
            if not isinstance(history.get(key), dict):
                history[key] = {}
        state["events"] = history
    return history


def _add(history: dict, at: float, kind: str, text: str, icon: str) -> None:
    day = time.strftime("%Y-%m-%d", time.localtime(at))
    history["days"].setdefault(day, []).append(
        {"at": int(at * 1000), "kind": kind, "text": text, "icon": icon})
    for old in sorted(history["days"])[:-KEEP_DAYS]:
        del history["days"][old]


def _publish(history: dict, now: float) -> list[dict]:
    today = datetime.date(*time.localtime(now)[:3])
    days = [(today - datetime.timedelta(days=back)).isoformat()
            for back in range(PUBLISH_DAYS - 1, -1, -1)]
    out = [event for day in days for event in history["days"].get(day, [])]
    out.sort(key=lambda event: event["at"])
    return out


def _spell(seconds: float) -> str:
    whole = max(0, int(seconds))
    hours, minutes = whole // 3600, (whole % 3600) // 60
    return f"{hours} h {minutes} min" if hours else f"{minutes} min"


# ---------------------------------------------------------------- sources


def _gap_limit(config: dict) -> int:
    interval = config.get("agent", {}).get("interval_seconds")
    try:
        interval = int(interval)
    except (TypeError, ValueError):
        interval = 0
    return max(MAX_GAP_SECONDS, interval * 3)


def _session(history: dict, now: float, online: bool, mode: str | None, gap_limit: int) -> None:
    """Sessions are recorded for servers too: that you played is not the same
    as what you did, and only the second one is anybody else's business."""
    session = history.get("session")

    if session and (now - session["last"] / 1000) > gap_limit:
        _end(history, session)
        session = history["session"] = None

    if online:
        if not session:
            where = " on a server" if mode == "multiplayer" else ""
            history["session"] = {"started": int(now * 1000), "last": int(now * 1000), "mode": mode}
            _add(history, now, "session", f"Started playing{where}", "minecraft:grass_block")
        else:
            session["last"] = int(now * 1000)
    elif session:
        _end(history, session)
        history["session"] = None


def _end(history: dict, session: dict) -> None:
    started, last = session["started"] / 1000, session["last"] / 1000
    where = " on a server" if session.get("mode") == "multiplayer" else ""

    if last - started < MIN_SESSION_SECONDS:
        _forget(history, started, session["started"])
        return
    _add(history, last, "session", f"Played for {_spell(last - started)}{where}", "minecraft:clock")


def _forget(history: dict, at: float, started_ms: int) -> None:
    """Drop the "Started playing" line for a session too short to report."""
    day = time.strftime("%Y-%m-%d", time.localtime(at))
    kept = [event for event in history["days"].get(day, [])
            if not (event["kind"] == "session" and event["at"] == started_ms)]
    if kept:
        history["days"][day] = kept
    else:
        history["days"].pop(day, None)


def _dimension(history: dict, player: dict, now: float) -> None:
    current = player.get("dimension")
    if not current:
        return
    previous = history["seen"].get("dimension")
    history["seen"]["dimension"] = current
    if previous and previous != current:
        name, icon = DIMENSIONS.get(current, (current.split(":")[-1].replace("_", " "), "minecraft:compass"))
        _add(history, now, "dimension", f"Entered {name}", icon)


def _advancements(history: dict, player: dict, now: float) -> None:
    recent = (player.get("advancements") or {}).get("recent") or []
    stamps = [entry.get("at") for entry in recent if isinstance(entry.get("at"), (int, float))]
    if not stamps:
        return

    # First sighting: the six most recent are whatever they already were, so
    # seed the mark instead of opening the feed with advancements from months ago.
    if "advancement_at" not in history["seen"]:
        history["seen"]["advancement_at"] = max(stamps)
        return

    last = history["seen"]["advancement_at"]
    for entry in sorted(recent, key=lambda item: item.get("at") or 0):
        at = entry.get("at")
        if not isinstance(at, (int, float)) or at <= last:
            continue
        title = entry.get("title") or "an advancement"
        _add(history, at / 1000, "advancement", f"Unlocked {title}", entry.get("icon") or "minecraft:book")
    history["seen"]["advancement_at"] = max(stamps + [last])


def _deaths(history: dict, stats: dict, now: float) -> None:
    deaths = stats.get("deaths")
    if not isinstance(deaths, int):
        return
    previous = history["seen"].get("deaths")
    history["seen"]["deaths"] = deaths
    if previous is None or deaths <= previous:
        return
    times = deaths - previous
    _add(history, now, "death", "Died" if times == 1 else f"Died {times}×", "minecraft:bone")


def _milestones(history: dict, stats: dict, now: float) -> None:
    values = {
        "kills": stats.get("mob_kills"),
        "km": (stats.get("travel_cm") or 0) / 100_000,
        "hours": (stats.get("play_time") or 0) / 20 / 3600,
    }
    for key, value in values.items():
        if not isinstance(value, (int, float)):
            continue
        passed = max((mark for mark in MARKS[key] if value >= mark), default=0)
        previous = history["marks"].get(key)
        history["marks"][key] = passed
        # Seed silently the first time: an established player has passed most of
        # these already, and the feed shouldn't open with years-old milestones.
        if previous is None or passed <= previous:
            continue
        template, icon = MARK_TEXT[key]
        _add(history, now, "milestone", template.format(value=passed), icon)
