# tests

No Minecraft or Cloudflare needed; RCON, the Worker's storage and subprocesses are faked.

```bash
agent/.venv/Scripts/python tests/test_curses.py      # curse rules over RCON
agent/.venv/Scripts/python tests/test_agent_mod.py   # mod source, command files, logout render
node tests/test_worker.mjs                           # Worker routes, broadcast/key logic, map markers
```

The WebSocket side (invite key, 10-viewer cap, broadcasts) needs the real Workers
runtime. Put test secrets in `worker/.dev.vars` (gitignored):

```
PUSH_TOKEN=local-test-token
VIEW_KEY=local-view-key
```

then run `cd worker && npx wrangler dev --port 8788` and, in another terminal,
`node tests/live_socket_test.mjs`.
