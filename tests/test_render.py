"""The map render: noticing that the world changed, and starting clean when it has."""

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("render", HERE.parent / "map" / "render.py")
render = importlib.util.module_from_spec(spec)
sys.modules["render"] = render
spec.loader.exec_module(render)

# Point the module's paths at a scratch dir rather than the real map/work.
tmp = Path(tempfile.mkdtemp())
render.WORK = tmp / "work"
render.WEBROOT = render.WORK / "web"
render.WORLD_MARKER = render.WORK / "rendered-world.json"

old = Path("/saves/Old World")
new = Path("/saves/New World")


def seed_a_render(world: Path):
    """What a finished render leaves behind: tiles and BlueMap's own cache."""
    (render.WEBROOT / "maps" / "overworld" / "tiles").mkdir(parents=True, exist_ok=True)
    (render.WEBROOT / "maps" / "overworld" / "tiles" / "0.png").write_bytes(b"tile")
    (render.WORK / "data" / "overworld").mkdir(parents=True, exist_ok=True)
    (render.WORK / "data" / "overworld" / "state").write_bytes(b"cache")
    render.remember_world(world)


# --- nothing rendered yet is not a change: don't wipe a first run
assert render.world_changed(old) is False

# --- the same world again is not a change either
seed_a_render(old)
assert render.world_changed(old) is False, "re-rendering one world must keep its cache"
assert (render.WEBROOT / "maps" / "overworld" / "tiles" / "0.png").is_file()

# --- a different world is
assert render.world_changed(new) is True

# --- and starting fresh clears both the tiles and the cache, not just one
render.start_fresh("test")
assert not (render.WEBROOT / "maps").exists(), "old tiles would be force-pushed to the map branch"
assert not (render.WORK / "data").exists(), "a stale cache makes BlueMap skip chunks of the new world"

# --- the marker survives being unreadable
render.WORLD_MARKER.write_text("{ not json", encoding="utf-8")
assert render.world_changed(new) is False, "a corrupt marker should not trigger a surprise wipe"

# --- and an empty one
render.WORLD_MARKER.write_text("{}", encoding="utf-8")
assert render.world_changed(new) is False

# --- remember_world round-trips
render.remember_world(new)
assert json.loads(render.WORLD_MARKER.read_text())["world"] == str(new)
assert render.world_changed(new) is False
assert render.world_changed(old) is True

print("ALL RENDER TESTS PASSED")
