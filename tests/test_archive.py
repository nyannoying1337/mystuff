"""The frame archive: what gets kept, what gets thinned, and what gets published."""

import json
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agent"))

import archive  # noqa: E402

tmp = Path(tempfile.mkdtemp())
game = tmp / ".minecraft"
(game / "mc-status").mkdir(parents=True)
store = tmp / "shots"

config = {
    "source": {"type": "mod", "game_dir": str(game)},
    "shots": {"keep": True, "every_seconds": 300, "directory": str(store)},
}

T0 = time.mktime((2026, 9, 15, 18, 0, 0, 0, 0, -1))


def frame(at, colour=(90, 140, 70)):
    """Write latest.png as the mod would, with a chosen mtime."""
    path = game / "mc-status" / "latest.png"
    Image.new("RGB", (1920, 1080), colour).save(path)
    import os
    os.utime(path, (at, at))
    return path


def player(online=True, position=None, dimension="minecraft:overworld"):
    out = {"online": online, "name": "nyannoying", "dimension": dimension}
    if position:
        out["position"] = position
    return out


def day_folder(at):
    return store / time.strftime("%Y-%m-%d", time.localtime(at))


# --- a frame is kept at two sizes, with an entry beside it
state: dict = {}
frame(T0)
archive.track(config, state, player(position=[120.4, 64.0, -33.2]), "singleplayer", T0)
folder = day_folder(T0)
kept = sorted(p.name for p in folder.glob("*.jpg"))
assert len(kept) == 2, kept
entries = json.loads((folder / "day.json").read_text())
assert len(entries) == 1 and entries[0]["position"] == [120, 64, -33], entries

# the thumbnail really is the smaller one
full = next(p for p in folder.glob("*.jpg") if not p.name.endswith(".t.jpg"))
thumb = next(p for p in folder.glob("*.t.jpg"))
assert Image.open(full).width == archive.FULL_WIDTH, Image.open(full).size
assert Image.open(thumb).width == archive.THUMB_WIDTH, Image.open(thumb).size

# --- thinning: a new frame inside the window is skipped
frame(T0 + 60, colour=(140, 90, 70))
archive.track(config, state, player(), "singleplayer", T0 + 60)
assert len(list(folder.glob("*.jpg"))) == 2, sorted(p.name for p in folder.glob("*.jpg"))

# --- past the window it's kept
frame(T0 + 400, colour=(70, 90, 140))
archive.track(config, state, player(), "singleplayer", T0 + 400)
assert len(list(folder.glob("*.jpg"))) == 4, sorted(p.name for p in folder.glob("*.jpg"))
assert len(json.loads((folder / "day.json").read_text())) == 2

# --- a server session is not archived unless you opted in
mp_state: dict = {}
mp_store = tmp / "mp"
mp_config = dict(config, shots=dict(config["shots"], directory=str(mp_store)))
frame(T0 + 800)
archive.track(mp_config, mp_state, player(), "multiplayer", T0 + 800)
assert not mp_store.exists(), list(mp_store.rglob("*"))

opted = dict(mp_config, privacy={"share_server_world": True})
archive.track(opted, mp_state, player(), "multiplayer", T0 + 800)
assert list(mp_store.rglob("*.jpg")), "opting in should archive a server frame"

# --- hide_coordinates keeps position out of the archive entirely
hidden_store = tmp / "hidden"
hidden = dict(config, shots=dict(config["shots"], directory=str(hidden_store)),
              privacy={"hide_coordinates": True})
frame(T0 + 1200)
archive.track(hidden, {}, player(position=[10.0, 20.0, 30.0]), "singleplayer", T0 + 1200)
written = json.loads(next(hidden_store.glob("*/day.json")).read_text())
assert "position" not in written[0], written

# --- off by default
off_store = tmp / "off"
archive.track(dict(config, shots={"directory": str(off_store)}), {}, player(), "singleplayer", T0 + 1600)
assert not off_store.exists()

# --- old days are pruned, newest kept
for back in range(1, 40):  # from 1: day 0 holds the real frames kept above
    old = day_folder(T0 - back * 86400)
    old.mkdir(parents=True, exist_ok=True)
    (old / "day.json").write_text("[]")
archive._prune(store, archive.KEEP_DAYS)
assert len(archive._days(store)) == archive.KEEP_DAYS, len(archive._days(store))

# --- staging publishes only the window, and never the private day.json
staged = tmp / "stage"
manifest = archive.stage(config, staged)
assert len(archive._days(store)) > archive.PUBLISH_DAYS
assert len([d for d in staged.iterdir() if d.is_dir()]) == archive.PUBLISH_DAYS
assert not list(staged.rglob("day.json")), list(staged.rglob("day.json"))
assert (staged / "index.json").is_file()
assert manifest["frames"], manifest

# --- publishing is off unless asked for
assert archive.publish(config) is False

print("ALL ARCHIVE TESTS PASSED")
