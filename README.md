# mc-status

A live status page for your machine and your Minecraft session, hosted free on
GitHub Pages. Your PC pushes; the page pulls. Nothing inbound, so it works fine
behind a captive portal.

```
your PC                     Cloudflare Worker              GitHub Pages
┌──────────────┐   POST     ┌──────────────┐    GET      ┌──────────────┐
│ agent.py     │ ─────────▶ │ /status /shot│ ◀────────── │ index.html   │
│ fastfetch    │  every 20s │ /bluemap/…   │  every 15s  │ map/ (render)│
│ RCON ◀─curses│            │  + KV store  │             │ your domain  │
│ screenshots/ │            └──────────────┘             └──────────────┘
└──────────────┘
      ▲ latest.png every 15s          map/render.py ──▶ `map` branch ──▶ /map
  mod/ (Fabric)
```

| Folder | What it is |
| --- | --- |
| `worker/` | Cloudflare Worker: stores the latest push, serves it to the page and the map |
| `agent/` | Python agent on your PC: collects, pushes, runs curses |
| `site/` | The status page |
| `mod/` | Optional Fabric client mod that keeps a fresh screenshot on disk |
| `map/` | BlueMap render + publish script |

## What shows up

Health and hunger with half-icons, XP bar and level, the full hotbar with stack
counts, durability bars and an enchant tint, coordinates, dimension, your most
recent in-game screenshot, the usual fastfetch line-up, recently fired curses,
and a link to the 3D world map with you on it. When the agent goes quiet for 90
seconds the page swaps to a "connection lost" panel instead of showing stale
numbers.

## 1. The Worker

```bash
cd worker
npx wrangler kv namespace create STATUS     # paste the id into wrangler.toml
npx wrangler secret put PUSH_TOKEN          # any long random string
npx wrangler deploy
```

Then in the Cloudflare dashboard, route it at a subdomain of yours —
`status-api.yourdomain.tld/*`. The free tier covers this comfortably: 100k
requests a day, and the page only polls while its tab is visible.

## 2. The agent

```bash
cd agent
python -m venv .venv && .venv/bin/pip install -r requirements.txt
cp config.example.toml config.toml    # fill in url, token, rcon password
.venv/bin/python agent.py --dry-run   # prints what it would publish
```

`--dry-run` is the one to check before anything goes public. It prints the exact
payload so you can see what's in it.

Enable RCON in your server's `server.properties`:

```
enable-rcon=true
rcon.port=25575
rcon.password=something-long
```

Bind RCON to localhost only. It is an unencrypted remote console — never expose
that port.

Once the dry run looks right:

```bash
cp mc-status-agent.service ~/.config/systemd/user/
systemctl --user enable --now mc-status-agent
```

## 3. The page

Edit the `API` constant at the top of the script block in `site/index.html` to
point at your Worker. Push, then either set Pages to deploy from `/site` via the
included workflow, or drop the file at the repo root.

For your custom domain, add a `CNAME` file containing your domain and point the
DNS record at GitHub. If the domain is already on Cloudflare, set that record to
DNS-only rather than proxied.

## Screenshots

The agent watches your screenshots folder and publishes whichever file is
newest. So out of the box, **F2 in game is the publish button** — no mod needed.

### The mod (optional)

`mod/` is a Fabric client mod for Minecraft 26.2 that overwrites
`screenshots/latest.png` every 15 seconds, so the page always has a recent
frame. The agent keeps doing the uploading.

- **Get the jar:** every push that touches `mod/` builds it. Open the repo's
  *Actions* tab → *Build mod* → the latest run → *mc-status-shot* artifact. Or
  build it yourself with `cd mod && ./gradlew build` (Java 25), which puts the
  jar in `mod/build/libs/`.
- **Install:** drop it into `.minecraft/mods/` next to Fabric API.
- **Configure:** the first launch writes `config/mc-status-shot.properties`:

  ```properties
  interval_seconds=15
  hide_hud=true        # hides HUD and chat for the one captured frame
  file_name=latest.png
  ```

It only captures actual gameplay. It skips frames while any menu is open
(chat included), while paused, or while no world is loaded. Each file is written
to `latest.png.tmp` first and then moved into place, so the agent never uploads
a half-written image.

## Item colours

Items render as flat coloured blocks, not real textures. Minecraft's art isn't
yours to redistribute, so shipping sprites out of the game jar in a public repo
is a copyright problem, however normal it feels. Options:

- extend `ITEM_COLORS` in `index.html` — unknown ids already fall back to a hash
  colour, so it degrades fine
- draw your own 16×16 tiles; you only need a dozen or so
- use a resource pack with a permissive licence

The font is Press Start 2P (SIL OFL) for the same reason. Monocraft is a closer
match if you want one and it's OFL too.

## Privacy

Deliberately never collected: local IP, hostname, and everything in the player
NBT except an allowlist in `SAFE_STATS`. A Minecraft update can add fields to
that blob, and an allowlist means new ones can't start leaking on their own.

Two things to decide for yourself:

- **Coordinates.** Fine for a solo world. If anyone else has your server
  address, set `hide_coordinates = true`.
- **Screenshots.** F2 captures your HUD, which includes chat. The mod hides the
  HUD for its frames (`hide_hud=true`), but anything you press F2 on yourself is
  published as-is.
- **The map.** It shows your whole world to anyone with the link, including
  bases. Your marker follows `hide_coordinates`: when it's on, no marker.

## The map

A BlueMap 3D render of your world at `/map`, with your live position on top.

The world only exists on your machine, so the render runs there too.
`map/render.py` renders it and force-pushes the result to a separate `map`
branch as a single commit, so re-renders never pile tile history onto `main`.
Any push to `map` redeploys Pages, and the workflow copies the branch into
`/map`.

Run it on the machine that has the world (Python 3.11+, Java 21+, git with push
access):

```bash
python map/render.py --world ~/server/world --accept-mojang-eula --publish
```

- **`--accept-mojang-eula`:** BlueMap needs textures from the Minecraft
  client jar and downloads it from Mojang. The flag confirms you own the game.
  The jar stays in `map/work/` and is never published.
- **Live marker URL:** taken from `worker.url` in `agent/config.toml`. Pass
  `--live-url https://status-api.yourdomain.tld/bluemap` to override.
- **Re-rendering:** later runs only re-render chunks that changed. Add `--force`
  after changing map settings.
- **Automating:** a nightly cron or systemd timer running the same command
  works. The render is incremental.

How the live marker works: the map's `live-data-root` points at the Worker. The
Worker answers BlueMap's `…/live/players.json` requests from your last status
push, and only shows the marker on the map for your current dimension.
BlueMap normally polls every second. `map/live-throttle.js` slows that to every
15 seconds and pauses while the tab is hidden, so one open tab stays well
inside the Workers free tier. It depends on BlueMap internals, so if you bump
`BLUEMAP_VERSION` in `render.py`, check the marker still moves.

**Size:** tiles stay gzipped and the browser decompresses them. A 169-chunk
test world rendered to about 6 MB, so expect roughly 35 MB per 1,000 explored
chunks. GitHub Pages caps a site at 1 GB, so for a huge world add a
`render-mask` in `render.py`.

## Cursed mode

The machine reaches into the world: a hot GPU sets the ground around you on
fire, a hot CPU brings a thunderstorm, low RAM makes you slow, and 12 hours of
uptime tells you to go to bed. Fired curses show up on the status page.

It is off by default. Enable it under `[cursed]` in `agent/config.toml`. Rules
are plain RCON commands, so you can write your own:

```toml
[[cursed.rules]]
name = "gpu on fire"
when = "gpu_temp >= 80"        # cpu_temp gpu_temp mem_percent uptime_hours health foodlevel xplevel
cooldown_seconds = 120
commands = ['execute at {player} run fill ~-2 ~ ~-2 ~2 ~ ~2 minecraft:fire replace minecraft:air']
```

A rule fires when its condition becomes true, then again every
`cooldown_seconds` while it stays true. Curses only run while you're in game.
`agent.py --dry-run` prints the live metrics and which rules would fire,
without running anything.

Temperatures come from fastfetch's `--cpu-temp` / `--gpu-temp`, which need
sensor support on your system. If `--dry-run` shows no `cpu_temp`, rules on it
never fire.

**Fire spreads.** Try the fire rule on a copy of your world first.
