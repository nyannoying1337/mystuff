import json, sys, time, tempfile, threading
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "agent"))
import agent

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
        "rotation": [90.0, 10.0], "world_path": str(world),
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
raw = agent.read_mod_state(config)
player = agent.collect_player(config, raw)
assert player["online"] is True
assert "world_path" not in player and "secret_future_field" not in player, player.keys()
assert player["armor"]["head"]["max_damage"] == 165 and player["offhand"]["id"] == "minecraft:shield"
assert len(player["inventory"]) == 1

# --- stale state => offline
write_state(written_at=int((time.time() - 120) * 1000))
assert agent.collect_player(config, agent.read_mod_state(config))["online"] is False

# --- missing state => offline
(game / "mc-status" / "state.json").unlink()
assert agent.collect_player(config, agent.read_mod_state(config)) == {"online": False}

# --- invalid name => offline
write_state(name="x; op me")
assert agent.collect_player(config, agent.read_mod_state(config)) == {"online": False}

# --- privacy hides position and rotation
write_state()
hidden = dict(config, privacy={"hide_coordinates": True})
p = agent.collect_player(hidden, agent.read_mod_state(hidden))
assert p["position"] is None and "rotation" not in p

# --- curses go to the command folder, not RCON
agent.MCRcon = lambda *a, **k: (_ for _ in ()).throw(AssertionError("RCON must not be used in mod mode"))
state = {}
now = time.time()
due = agent.due_curses(config, agent.curse_metrics({}, player), state, now)
agent.cast_curses(config, "nyannoying", due, state, now)
files = sorted((game / "mc-status" / "commands").glob("*.json"))
assert len(files) == 1, files
body = json.loads(files[0].read_text())
assert body == {"commands": ["execute at nyannoying run fill ~-2 ~ ~-2 ~2 ~ ~2 minecraft:fire replace minecraft:air"]}
assert state["curse_log"][0]["name"] == "xp fire"
assert not list((game / "mc-status" / "commands").glob("*.tmp"))

# --- screenshot directory defaults to the mod folder
assert agent.screenshot_directory(config) == game / "mc-status"

# --- logout triggers a render with the right arguments, once the save settles
calls = []
class FakeProc:
    stdout = iter(["rendered to web\n"])
    def wait(self, timeout=None): return 0
agent.subprocess.Popen = lambda cmd, **kw: calls.append(cmd) or FakeProc()
real_wait = agent.wait_for_world_saved
agent.wait_for_world_saved = lambda w, rejoined, **kw: real_wait(w, rejoined, quiet_seconds=0, timeout=5, poll=0.05)

state = {}
write_state()
raw = agent.read_mod_state(config)
agent.track_presence(config, state, agent.collect_player(config, raw), raw)
assert state["was_online"] and state["world_path"] == str(world)
write_state(online=False)
raw = agent.read_mod_state(config)
agent.track_presence(config, state, agent.collect_player(config, raw), raw)
state["render_thread"].join(10)
assert len(calls) == 1, calls
cmd = calls[0]
assert cmd[cmd.index("--world") + 1] == str(world)
assert cmd[cmd.index("--center") + 1: cmd.index("--center") + 3] == ["120", "-33"]
assert cmd[cmd.index("--dimension") + 1] == "minecraft:overworld"
assert "--accept-mojang-eula" in cmd and "--publish" in cmd
assert cmd[cmd.index("--live-url") + 1] == "http://127.0.0.1:8787/bluemap"
assert agent.last_seen_payload(config, state)["position"] == [120.5, 64.0, -33.2]

# --- rejoining during the save wait cancels the render
calls.clear()
agent.wait_for_world_saved = real_wait
(world / "level.dat").write_bytes(b"fresh")  # just written => not settled yet
state = {"was_online": True, "world_path": str(world),
         "last_seen": {"position": [1, 64, 1], "dimension": "minecraft:overworld", "at": 0}}
agent.start_logout_render(config, state)
time.sleep(0.3)
state["was_online"] = True  # player came back
state["render_thread"].join(10)
assert calls == [], calls

# --- render disabled => nothing
calls.clear()
off = dict(config, map={"render_on_logout": False})
state = {"was_online": True, "world_path": str(world),
         "last_seen": {"position": [1, 64, 1], "dimension": "minecraft:overworld", "at": 0}}
agent.track_presence(off, state, {"online": False}, None)
assert "render_thread" not in state

print("ALL AGENT MOD-SOURCE TESTS PASSED")

# --- agent restarted while offline: last_seen rebuilt from state.json, no render
calls.clear()
state = {}
write_state(online=False, written_at=1234)
raw = agent.read_mod_state(config)
agent.track_presence(config, state, agent.collect_player(config, raw), raw)
assert state["last_seen"] == {"position": [120.5, 64.0, -33.2], "dimension": "minecraft:overworld", "at": 1234, "mode": "singleplayer"}
assert "render_thread" not in state and calls == []
print("RESTART-OFFLINE TEST PASSED")

# ============================================================ singleplayer vs multiplayer
calls.clear()
agent.wait_for_world_saved = lambda w, rejoined, **kw: True

def session(state, **over):
    write_state(**over)
    raw = agent.read_mod_state(config)
    player = agent.collect_player(config, raw)
    agent.track_presence(config, state, player, raw)
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
assert agent.curses_allowed(config, raw) is False
assert agent.curses_allowed(config, {"mode": "singleplayer", "world_path": str(world)}) is True
assert agent.curses_allowed(dict(config, source={"type": "rcon"}), None) is True

# --- singleplayer, then a server, then leave the server: no render, no stale world reuse
state = {}
session(state, mode="singleplayer")                      # world_path = test world
assert state["world_path"] == str(world)
session(state, mode="multiplayer", world_path=None, position=[999.0, 70.0, -999.0])
assert state["world_path"] is None
session(state, mode="multiplayer", world_path=None, online=False)
join_thread(state)
assert calls == [], f"left a server but rendered: {calls}"
seen = agent.last_seen_payload(config, state)
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

# --- mod 1.0.0 state (no mode): world_path means singleplayer, none means multiplayer
assert agent.session_mode({"world_path": "x"}) == "singleplayer"
assert agent.session_mode({"position": [1, 2, 3]}) == "multiplayer"
assert agent.session_mode(None) is None

# --- agent restarted after a server session: last_seen without coordinates
state = {}
write_state(mode="multiplayer", world_path=None, online=False, written_at=5555)
raw = agent.read_mod_state(config)
agent.track_presence(config, state, agent.collect_player(config, raw), raw)
assert state["last_seen"] == {"mode": "multiplayer", "at": 5555}

print("SINGLEPLAYER/MULTIPLAYER TESTS PASSED")
