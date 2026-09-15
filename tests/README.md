# tests

No Minecraft or Cloudflare needed; RCON, the Worker's storage and subprocesses are faked.
Run them with the agent's Python (`agent/.venv`) after `pip install -r agent/requirements.txt`.

```bash
python tests/test_curses.py      # curse rules over RCON
python tests/test_events.py      # the day's timeline: sessions, milestones, restarts
python tests/test_agent_mod.py   # mod source, logout render, panorama, play time, checklists, privacy
node tests/test_worker.mjs       # Worker routes, broadcasts, panorama, map markers
node tests/test_server_worker.mjs  # server tool: keys, per-viewer filtering, write throttling
```

More in [docs/development.md](../docs/development.md).

The WebSocket side (invite key, 10-viewer cap, broadcasts) needs the real Workers
runtime. Put test secrets in `worker/.dev.vars` (gitignored):

```
PUSH_TOKEN=local-test-token
VIEW_KEY=local-view-key
```

then run `cd worker && npx wrangler dev --port 8788` and, in another terminal,
`node tests/live_socket_test.mjs`.
