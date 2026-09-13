# tests

No Minecraft or Cloudflare needed; RCON, the Worker's storage and subprocesses are faked.

```bash
agent/.venv/Scripts/python tests/test_curses.py      # curse rules over RCON
agent/.venv/Scripts/python tests/test_agent_mod.py   # mod source, command files, logout render
node tests/test_worker.mjs                           # Worker routes, Durable Object store, map markers
```
