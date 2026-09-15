"""The day's timeline: what becomes an event, what stays quiet, and what survives a restart."""

import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agent"))

import events  # noqa: E402

tmp = Path(tempfile.mkdtemp())
config = {"agent": {"events_file": str(tmp / "events.json")}}

DAY = 86400
T0 = time.mktime((2026, 9, 15, 12, 0, 0, 0, 0, -1))


def player(online=True, dimension="minecraft:overworld", stats=None, recent=None):
    out = {"online": online, "name": "nyannoying"}
    if dimension:
        out["dimension"] = dimension
    if stats is not None:
        out["stats"] = stats
    if recent is not None:
        out["advancements"] = {"recent": recent}
    return out


def kinds(published):
    return [event["kind"] for event in published]


def texts(published):
    return [event["text"] for event in published]


# --- a fresh install seeds silently: no feed full of years-old milestones
state = {}
established = {"deaths": 97, "mob_kills": 24_000, "travel_cm": 51_000_000, "play_time": 20_000_000}
first = events.track(config, state, player(stats=established), "singleplayer", T0)
assert kinds(first) == ["session"], first
assert texts(first) == ["Started playing"], first

# --- and the marks were seeded at the tiers already passed, not zero
history = state["events"]
assert history["marks"] == {"kills": 10_000, "km": 100, "hours": 100}, history["marks"]
assert history["seen"]["deaths"] == 97

# --- a quiet tick adds nothing
quiet = events.track(config, state, player(stats=established), "singleplayer", T0 + 10)
assert kinds(quiet) == ["session"], quiet

# --- crossing a milestone is the event; staying past it is not
passed = dict(established, mob_kills=100_001)
out = events.track(config, state, player(stats=passed), "singleplayer", T0 + 20)
assert texts(out)[-1] == "100,000 mobs defeated", texts(out)
again = events.track(config, state, player(stats=passed), "singleplayer", T0 + 30)
assert kinds(again).count("milestone") == 1, kinds(again)

# --- deaths come off the counter, and a double death reads as one line
died = dict(passed, deaths=99)
out = events.track(config, state, player(stats=died), "singleplayer", T0 + 40)
assert texts(out)[-1] == "Died 2×", texts(out)

# --- changing dimension
out = events.track(config, state, player(dimension="minecraft:the_nether", stats=died), "singleplayer", T0 + 50)
assert texts(out)[-1] == "Entered the Nether", texts(out)

# --- advancements: the first sighting seeds, later ones publish
recent = [{"title": "Stone Age", "icon": "minecraft:cobblestone", "at": int((T0 - DAY) * 1000)}]
out = events.track(config, state, player(stats=died, recent=recent), "singleplayer", T0 + 60)
assert "Unlocked Stone Age" not in texts(out), texts(out)

fresh = [{"title": "Diamonds!", "icon": "minecraft:diamond", "at": int((T0 + 65) * 1000)}] + recent
out = events.track(config, state, player(stats=died, recent=fresh), "singleplayer", T0 + 70)
assert texts(out)[-1] == "Unlocked Diamonds!", texts(out)

# --- logging out closes the session with how long it ran
out = events.track(config, state, player(online=False), None, T0 + 3600)
assert texts(out)[-1].startswith("Played for "), texts(out)
assert state["events"].get("session") is None

# --- a server session is recorded as having happened, without detail
state_mp = {}
mp_config = {"agent": {"events_file": str(tmp / "mp.json")}}
out = events.track(mp_config, state_mp, player(stats=None), "multiplayer", T0)
assert texts(out) == ["Started playing on a server"], texts(out)
for tick in range(10, 1810, 10):  # the real 10 s cadence, not one jump
    events.track(mp_config, state_mp, player(stats=None), "multiplayer", T0 + tick)
out = events.track(mp_config, state_mp, player(online=False), "multiplayer", T0 + 1810)
assert texts(out)[-1] == "Played for 30 min on a server", texts(out)

# --- a session seen once is dropped entirely, both lines
state_blip: dict = {}
blip_config = {"agent": {"events_file": str(tmp / "blip.json")}}
out = events.track(blip_config, state_blip, player(), "singleplayer", T0)
assert texts(out) == ["Started playing"], texts(out)
out = events.track(blip_config, state_blip, player(online=False), None, T0 + 20)
assert out == [], texts(out)

# --- the agent stopping mid-session closes it where it stood, not hours later
state_gap = {}
gap_config = {"agent": {"events_file": str(tmp / "gap.json")}}
events.track(gap_config, state_gap, player(), "singleplayer", T0)
for tick in range(10, 610, 10):
    events.track(gap_config, state_gap, player(), "singleplayer", T0 + tick)
out = events.track(gap_config, state_gap, player(), "singleplayer", T0 + 9 * 3600)
assert "Played for 10 min" in texts(out), texts(out)
assert texts(out)[-1] == "Started playing", texts(out)

# --- state survives a restart: reload from disk, keep the same session
reloaded: dict = {}
out = events.track(gap_config, reloaded, player(), "singleplayer", T0 + 9 * 3600 + 10)
assert kinds(out).count("session") == 3, kinds(out)

# --- days roll off after KEEP_DAYS
old = state["events"]["days"]
old[(time.strftime("%Y-%m-%d", time.localtime(T0 - 40 * DAY)))] = [{"at": 1, "kind": "x", "text": "x", "icon": "x"}]
events.track(config, state, player(online=False), None, T0 + 3700)
assert len(state["events"]["days"]) <= events.KEEP_DAYS, sorted(state["events"]["days"])

# --- only the publish window is sent, not the whole ten days
assert events.PUBLISH_DAYS == 1
yesterday = time.strftime("%Y-%m-%d", time.localtime(T0 - DAY))
state["events"]["days"][yesterday] = [{"at": 1, "kind": "session", "text": "old", "icon": "x"}]
out = events.track(config, state, player(online=False), None, T0 + 3800)
assert "old" not in texts(out), texts(out)

print("ALL EVENT TIMELINE TESTS PASSED")
