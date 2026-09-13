import json, sys, time, tempfile, threading
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "agent"))
import agent, collect, cursed, media, playtime, presence, sysinfo, upload

tmp = Path(tempfile.mkdtemp())
game = tmp / "game"
(game / "mc-status").mkdir(parents=True)
world = tmp / "world"
world.mkdir()
(world / "level.dat").write_bytes(b"x")

config = {
    "worker": {"url": "http://127.0.0.1:8787", "token": "t"},
    "source": {"type": "mod", "game_dir": str(game)},
    "map": {"render_on_logout": True, "radius_chunks": 8, "accept_mojang_eula": True, "publish": True},
    "cursed": {"enabled": True, "rules": [
        {"name": "xp fire", "when": "xplevel >= 5", "cooldown_seconds": 30,
         "commands": ["execute at {player} run fill ~-2 ~ ~-2 ~2 ~ ~2 minecraft:fire replace minecraft:air"]},
    ]},
}

def write_state(**over):
    state = {
        "online": True, "name": "nyannoying", "health": 18.0, "foodlevel": 20, "xplevel": 7, "xpp": 0.3,
        "selecteditemslot": 0, "dimension": "minecraft:overworld", "position": [120.5, 64.0, -33.2],
        "rotation": [90.0, 10.0], "world_path": str(world), "mode": "singleplayer",
        "hotbar": [{"id": "minecraft:diamond_sword", "count": 1, "slot": 0, "damage": 400, "max_damage": 1561}],
        "inventory": [{"id": "minecraft:torch", "count": 64, "slot": 9}],
        "armor": {"head": {"id": "minecraft:iron_helmet", "count": 1, "damage": 40, "max_damage": 165}},
        "offhand": {"id": "minecraft:shield", "count": 1},
        "written_at": int(time.time() * 1000),
        "secret_future_field": "must not be published",
    }
    state.update(over)
    (game / "mc-status" / "state.json").write_text(json.dumps(state))

# --- fresh state is online, publishable fields only
write_state()
raw = collect.read_mod_state(config)
player = collect.collect_player(config, raw)
assert player["online"] is True
assert "world_path" not in player and "secret_future_field" not in player, player.keys()
assert player["armor"]["head"]["max_damage"] == 165 and player["offhand"]["id"] == "minecraft:shield"
assert len(player["inventory"]) == 1

# --- stale state => offline
write_state(written_at=int((time.time() - 120) * 1000))
assert collect.collect_player(config, collect.read_mod_state(config))["online"] is False

# --- missing state => offline
(game / "mc-status" / "state.json").unlink()
assert collect.collect_player(config, collect.read_mod_state(config)) == {"online": False}

# --- invalid name => offline
write_state(name="x; op me")
assert collect.collect_player(config, collect.read_mod_state(config)) == {"online": False}

# --- privacy hides position and rotation
write_state()
hidden = dict(config, privacy={"hide_coordinates": True})
p = collect.collect_player(hidden, collect.read_mod_state(hidden))
assert p["position"] is None and "rotation" not in p

# --- curses go to the command folder, not RCON
collect.MCRcon = lambda *a, **k: (_ for _ in ()).throw(AssertionError("RCON must not be used in mod mode"))
state = {}
now = time.time()
due = cursed.due(config, cursed.metrics({}, player), state, now)
cursed.cast(config, "nyannoying", due, state, now)
files = sorted((game / "mc-status" / "commands").glob("*.json"))
assert len(files) == 1, files
body = json.loads(files[0].read_text())
assert body == {"commands": ["execute at nyannoying run fill ~-2 ~ ~-2 ~2 ~ ~2 minecraft:fire replace minecraft:air"]}
assert state["curse_log"][0]["name"] == "xp fire"
assert not list((game / "mc-status" / "commands").glob("*.tmp"))

# --- with the mod, only its own latest.png is published
assert media.screenshot_path(config) is None
(game / "mc-status" / "latest.png").write_bytes(b"png")
(game / "mc-status" / "panorama.png").write_bytes(b"png")
assert media.screenshot_path(config) == game / "mc-status" / "latest.png"

# --- logout triggers a render with the right arguments, once the save settles
calls = []
class FakeProc:
    stdout = iter(["rendered to web\n"])
    def wait(self, timeout=None): return 0
presence.subprocess.Popen = lambda cmd, **kw: calls.append(cmd) or FakeProc()
real_wait = presence.wait_for_world_saved
presence.wait_for_world_saved = lambda w, rejoined, **kw: real_wait(w, rejoined, quiet_seconds=0, timeout=5, poll=0.05)

state = {}
write_state()
raw = collect.read_mod_state(config)
presence.track(config, state, collect.collect_player(config, raw), raw, collect.session_mode(raw))
assert state["was_online"] and state["world_path"] == str(world)
write_state(online=False)
raw = collect.read_mod_state(config)
presence.track(config, state, collect.collect_player(config, raw), raw, collect.session_mode(raw))
state["render_thread"].join(10)
assert len(calls) == 1, calls
cmd = calls[0]
assert cmd[cmd.index("--world") + 1] == str(world)
assert cmd[cmd.index("--center") + 1: cmd.index("--center") + 3] == ["120", "-33"]
assert cmd[cmd.index("--dimension") + 1] == "minecraft:overworld"
assert "--accept-mojang-eula" in cmd and "--publish" in cmd
assert cmd[cmd.index("--live-url") + 1] == "http://127.0.0.1:8787/bluemap"
assert presence.last_seen_payload(config, state)["position"] == [120.5, 64.0, -33.2]

# --- rejoining during the save wait cancels the render
calls.clear()
presence.wait_for_world_saved = real_wait
(world / "level.dat").write_bytes(b"fresh")  # just written => not settled yet
state = {"was_online": True, "world_path": str(world),
         "last_seen": {"position": [1, 64, 1], "dimension": "minecraft:overworld", "at": 0}}
presence.start_logout_render(config, state)
time.sleep(0.3)
state["was_online"] = True  # player came back
state["render_thread"].join(10)
assert calls == [], calls

# --- render disabled => nothing
calls.clear()
off = dict(config, map={"render_on_logout": False})
state = {"was_online": True, "world_path": str(world),
         "last_seen": {"position": [1, 64, 1], "dimension": "minecraft:overworld", "at": 0}}
presence.track(off, state, {"online": False}, None, None)
assert "render_thread" not in state

print("ALL AGENT MOD-SOURCE TESTS PASSED")

# --- agent restarted while offline: last_seen rebuilt from state.json, no render
calls.clear()
state = {}
write_state(online=False, written_at=1234)
raw = collect.read_mod_state(config)
presence.track(config, state, collect.collect_player(config, raw), raw, collect.session_mode(raw))
assert state["last_seen"] == {"position": [120.5, 64.0, -33.2], "dimension": "minecraft:overworld", "at": 1234, "mode": "singleplayer"}
assert "render_thread" not in state and calls == []
print("RESTART-OFFLINE TEST PASSED")

# ============================================================ singleplayer vs multiplayer
calls.clear()
presence.wait_for_world_saved = lambda w, rejoined, **kw: True

def session(state, **over):
    write_state(**over)
    raw = collect.read_mod_state(config)
    player = collect.collect_player(config, raw)
    presence.track(config, state, player, raw, collect.session_mode(raw))
    return player, raw

def join_thread(state):
    thread = state.get("render_thread")
    if thread:
        thread.join(10)

# --- multiplayer: mode published, coordinates stripped, no world path kept
state = {}
player, raw = session(state, mode="multiplayer", world_path=None, position=[999.0, 70.0, -999.0])
assert player["mode"] == "multiplayer"
assert "position" not in player and "rotation" not in player, player
assert state["world_path"] is None and state["last_seen"]["mode"] == "multiplayer"
assert "position" not in state["last_seen"]

# --- no curses on a server
assert cursed.allowed(config, raw) is False
assert cursed.allowed(config, {"mode": "singleplayer", "world_path": str(world)}) is True
assert cursed.allowed(dict(config, source={"type": "rcon"}), None) is True

# --- singleplayer, then a server, then leave the server: no render, no stale world reuse
state = {}
session(state, mode="singleplayer")                      # world_path = test world
assert state["world_path"] == str(world)
session(state, mode="multiplayer", world_path=None, position=[999.0, 70.0, -999.0])
assert state["world_path"] is None
session(state, mode="multiplayer", world_path=None, online=False)
join_thread(state)
assert calls == [], f"left a server but rendered: {calls}"
seen = presence.last_seen_payload(config, state)
assert seen["mode"] == "multiplayer" and "position" not in seen

# --- a server, then singleplayer, then leave singleplayer: renders the singleplayer spot
calls.clear()
state = {}
session(state, mode="multiplayer", world_path=None, position=[999.0, 70.0, -999.0])
session(state, mode="singleplayer", position=[12.0, 64.0, 34.0])
session(state, mode="singleplayer", online=False)
join_thread(state)
assert len(calls) == 1, calls
cmd = calls[0]
assert cmd[cmd.index("--world") + 1] == str(world)
assert cmd[cmd.index("--center") + 1: cmd.index("--center") + 3] == ["12", "34"]

# --- only an explicit singleplayer session counts as one
assert collect.session_mode({"mode": "singleplayer"}) == "singleplayer"
assert collect.session_mode({"world_path": "x"}) == "multiplayer"
assert collect.session_mode(None) is None

# --- agent restarted after a server session: last_seen without coordinates
state = {}
write_state(mode="multiplayer", world_path=None, online=False, written_at=5555)
raw = collect.read_mod_state(config)
presence.track(config, state, collect.collect_player(config, raw), raw, collect.session_mode(raw))
assert state["last_seen"] == {"mode": "multiplayer", "at": 5555}

print("SINGLEPLAYER/MULTIPLAYER TESTS PASSED")

# ============================================================ world, stats, advancements (mod 1.0.2)
extras = dict(
    world={"name": "My World", "day": 12, "time": 6000, "weather": "rain", "biome": "minecraft:plains"},
    stats={"play_time": 72000, "deaths": 3},
    advancements={"done": 10, "total": 125, "recent": [], "in_progress": []},
    game={"fps": 144, "mem_used_mb": 2048, "mem_max_mb": 4096},
    joined_at=1234,
)

# --- singleplayer: all published
write_state(mode="singleplayer", **extras)
player = collect.collect_player(config, collect.read_mod_state(config))
for key in extras:
    assert key in player, key

# --- multiplayer: world, stats and advancements dropped even if a mod sends them
write_state(mode="multiplayer", world_path=None, **extras)
player = collect.collect_player(config, collect.read_mod_state(config))
assert not {"world", "stats", "advancements", "position"} & player.keys(), player.keys()
assert player["game"]["fps"] == 144

# --- offline: stats stay (last known), live-only fields go
write_state(mode="singleplayer", online=False, **extras)
player = collect.collect_player(config, collect.read_mod_state(config))
assert "stats" in player and "advancements" in player
assert "game" not in player and "joined_at" not in player

# --- system collector never raises and never reads identifying names
system = sysinfo.collect_safely()
assert not {"hostname", "host", "user", "ip"} & system.keys(), system.keys()
metrics = cursed.metrics(dict(system, cpu_percent=50.0, gpu_percent=20.0), {})
assert metrics["cpu_percent"] == 50.0 and metrics["gpu_percent"] == 20.0

print("WORLD/STATS/SYSTEM TESTS PASSED")

# ============================================================ last death, play time per day
death = {"dimension": "minecraft:overworld", "position": [10, 64, -5]}
write_state(mode="singleplayer", last_death=death)
assert collect.collect_player(config, collect.read_mod_state(config))["last_death"] == death
write_state(mode="multiplayer", world_path=None, last_death=death)
assert "last_death" not in collect.collect_player(config, collect.read_mod_state(config))
write_state(mode="singleplayer", last_death=death)
hidden = dict(config, privacy={"hide_coordinates": True})
assert "last_death" not in collect.collect_player(hidden, collect.read_mod_state(config))

pt_config = dict(config, agent={"playtime_file": str(tmp / "playtime.json")})
pt_state = {}
noon = time.mktime((2026, 9, 13, 12, 0, 0, 0, 0, -1))
assert playtime.track(pt_config, pt_state, True, noon)[-1] == {"date": "2026-09-13", "seconds": 0}
playtime.track(pt_config, pt_state, True, noon + 10)
playtime.track(pt_config, pt_state, True, noon + 20)
playtime.track(pt_config, pt_state, True, noon + 20 + 3600)   # PC slept: not counted
days = playtime.track(pt_config, pt_state, False, noon + 3630)
assert len(days) == 7 and days[-1]["seconds"] == 20 and days[0]["date"] == "2026-09-07", days
# offline gaps don't count, and the file survives an agent restart
playtime.track(pt_config, pt_state, True, noon + 4000)
fresh = {}
assert playtime.track(pt_config, fresh, False, noon + 4010)[-1]["seconds"] == 20
assert json.loads((tmp / "playtime.json").read_text())["2026-09-13"] == 20

print("DEATH/PLAYTIME TESTS PASSED")

# ============================================================ logout panorama
from PIL import Image

sent_images = []
upload.push_image = lambda cfg, route, image: sent_images.append((route, len(image)))
folder = game / "mc-status"
Image.new("RGB", (60, 10), "skyblue").save(folder / "panorama.png")
logout = {"mode": "singleplayer", "position": [1, 64, 1], "dimension": "minecraft:overworld", "at": 1_000_000}

def taken(at):
    (folder / "panorama.json").write_text(json.dumps({"at": at}))

pano_state = {}
taken(1_000_000 - 30_000)                                  # paused 30 s before logout
assert media.sync_panorama(config, pano_state, logout) == 970_000
assert sent_images == [("pano", sent_images[0][1])] and sent_images[0][1] > 0
assert media.sync_panorama(config, pano_state, logout) == 970_000 and len(sent_images) == 1  # not re-sent

taken(1_000_000 - 20 * 60_000)                             # an older session's panorama
assert media.sync_panorama(config, {}, logout) is None

taken(1_000_000 + 20_000)                                  # just after the last online check: still this logout
assert media.sync_panorama(config, {}, logout) == 1_020_000

assert media.sync_panorama(config, {}, dict(logout, mode="multiplayer")) is None
assert media.sync_panorama(dict(config, source={"type": "rcon"}), {}, logout) is None
(folder / "panorama.json").unlink()
assert media.sync_panorama(config, {}, logout) is None

print("PANORAMA TESTS PASSED")

# ============================================================ advancement checklists (mod 1.0.5)
checklist = {"id": "minecraft:adventure/adventuring_time", "title": "Adventuring Time", "type": "challenge",
             "icon": "minecraft:diamond_boots", "done": ["minecraft:plains"], "missing": ["minecraft:desert"]}
adv = {"done": 1, "total": 125, "recent": [], "in_progress": [], "checklists": [checklist]}
write_state(mode="singleplayer", advancements=adv)
assert collect.collect_player(config, collect.read_mod_state(config))["advancements"]["checklists"] == [checklist]
write_state(mode="multiplayer", world_path=None, advancements=adv)
assert "advancements" not in collect.collect_player(config, collect.read_mod_state(config))
print("CHECKLIST TESTS PASSED")
