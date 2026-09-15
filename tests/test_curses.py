import sys, tomllib, json
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "agent"))
import agent, collect, cursed, media, playtime, presence, sysinfo, upload

sent = []

class FakeRcon:
    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def command(self, cmd):
        sent.append(cmd)
        if cmd.startswith("data get entity"):
            return ('nyannoying has the following entity data: {Health: 7.0f, foodLevel: 18, XpLevel: 3, '
                    'XpP: 0.5f, Dimension: "minecraft:overworld", Pos: [10.5d, 64.0d, -20.25d], '
                    'Rotation: [90.0f, 12.5f], SelectedItemSlot: 0, Inventory: []}')
        return "ok"

collect.MCRcon = FakeRcon
config = tomllib.loads((HERE.parent / "agent" / "config.example.toml").read_text(encoding="utf-8"))
config["cursed"]["enabled"] = True
config["source"] = {"type": "rcon"}  # this test covers the server path
config["rcon"]["player"] = "nyannoying"
import tempfile
scratch = Path(tempfile.mkdtemp())
config.setdefault("agent", {})["playtime_file"] = str(scratch / "playtime.json")
# run_once records the timeline too; keep it out of the repo
config["agent"]["events_file"] = str(scratch / "events.json")

hot = {"cpu_temp": 70.0, "gpu_temp": 83.2, "mem_used": 15e9, "mem_total": 16e9, "uptime_seconds": 13 * 3600}
sysinfo.collect_safely = lambda: hot
pushed = []
upload.push_status = lambda cfg, payload: pushed.append(payload)

state = {}
t = [1000.0]
agent.time.time = lambda: t[0]

agent.run_once(config, state)
first = [c for c in sent if not c.startswith("data get")]
print("round 1 commands:", json.dumps(first, indent=1))
assert any("fill ~-2 ~ ~-2 ~2 ~ ~2 minecraft:fire" in c and "at nyannoying" in c for c in first)
assert not any("weather" in c for c in first), "cpu 70 < 85 must not fire"
assert 'title nyannoying actionbar "this pc has been up for 12 hours. go to bed."' in first
assert pushed[-1]["curses"][0]["name"] in {"gpu on fire", "out of ram", "go to bed"}
assert pushed[-1]["player"]["rotation"] == [90.0, 12.5]

sent.clear(); t[0] += 30
agent.run_once(config, state)
second = [c for c in sent if not c.startswith("data get")]
print("round 2 (+30s) commands:", second)
assert second == [], "all cooldowns >= 60s"

sent.clear(); t[0] += 40  # 70s after first: only 'out of ram' (60s) is due
agent.run_once(config, state)
third = [c for c in sent if not c.startswith("data get")]
print("round 3 (+70s) commands:", third)
assert third == ["effect give nyannoying minecraft:slowness 30 1"]

# disabled => nothing
sent.clear(); t[0] += 10_000; config["cursed"]["enabled"] = False
agent.run_once(config, state)
assert [c for c in sent if not c.startswith("data get")] == []

# bad player name is refused before reaching rcon
config["rcon"]["player"] = "x; op everyone"
assert collect.collect_player(config) == {"online": False}

# bad condition is skipped, not fatal
config["cursed"] = {"enabled": True, "rules": [{"name": "bad", "when": "gpu_temp >>= 1", "commands": ["say hi"]}]}
assert cursed.due(config, {"gpu_temp": 99}, {}, 0) == []
print("payload curses:", pushed[-1].get("curses"))
print("ALL CURSE TESTS PASSED")
