> **PROOF OF CONCEPT, not released.** This local fork adds a *server tool*: a Fabric server mod that
> publishes every player on a server, an admin page (`site/server.html` with the admin key) and
> per-player pages (signed player links). Tested locally only; it isn't pushed or deployed anywhere.
>
> Local test: `cd mod && gradlew runServer` (config in `mod/run/config/mc-status-server.properties`),
> `cd worker && npx wrangler dev --port 8789` (secrets `PUSH_TOKEN`, `VIEW_KEY`, `ADMIN_KEY`,
> `PLAYER_LINK_SECRET` in `worker/.dev.vars`), serve `site/` on port 8766, then join `localhost`.
> Tests: `node tests/test_server_worker.mjs`.

# mc-status

A live, invite-only status page for your Minecraft sessions and the PC they run
on. It shows your vitals, inventory, advancements, stats, world and machine load
while you play. After you log out, visitors can look around a 360° view of
where you left and explore a 3D map of the area.

Everything runs on free tiers (GitHub Pages, Cloudflare Workers). Your PC only
pushes data out: nothing reaches in, so it also works behind a router or a
captive portal.

```
          your PC                           Cloudflare Worker        GitHub Pages
┌─────────────────────────────┐   push    ┌────────────────┐  live ┌──────────────┐
│ Minecraft + mc-status mod   │ ────────▶ │ /status /shot  │ ────▶ │ status page  │
│   state.json, latest.png,   │           │ /pano /live    │  WS   │ /map         │
│   panorama.png; runs curses │           │ Durable Object │       └──────▲───────┘
│        ▲ commands  │ files  │           └───────▲────────┘              │
│        │           ▼        │                   │                       │
│ agent/  ────────────────────┼───────────────────┘                       │
│   machine load, curses,     │                                           │
│   on logout: map/render.py ─┼──▶ `map` branch ─────────────────────────┘
└─────────────────────────────┘
```

| Folder | What it is |
| --- | --- |
| `mod/` | Fabric client mod: writes your state, a HUD-free frame and a logout panorama; runs curses |
| `agent/` | Python agent: reads the mod's files, adds machine load, pushes, renders the map on logout |
| `worker/` | Cloudflare Worker: stores the latest push and streams it to viewers |
| `site/` | The status page (static HTML, CSS and ES modules, no build step) |
| `map/` | BlueMap render and publish script, plus the map page's theme and live marker |
| `setup.py` | Setup wizard: config, secrets, Worker deploy, autostart, invite links |

## What shows up

- **In game:**
  - armor, hearts, hunger and XP, drawn with the game's sprites on your latest frame;
  - your inventory on the real inventory screen, with tooltips;
  - coordinates and session length;
  - the game's FPS and tick time.
- **In your own worlds:**
  - day, time, weather, biome, difficulty and game mode;
  - advancements per tab, recently earned and almost done;
  - statistics (play time, deaths, kills, blocks mined, distance, favourites);
  - the advancement toast on the frame for 5 minutes after you earn one.
- **Logged out:**
  - a 360° view of where you left, which visitors can drag;
  - what you logged out with, and your stats as of that session;
  - a 3D map of the surrounding area, marked with where you were last seen and where you last died.
- **Always:**
  - CPU, GPU, memory and video memory load;
  - play time per day for the last week;
  - curses that fired recently.
- **On someone else's server:** only that you're playing, your vitals and your
  inventory. See [Multiplayer](#multiplayer).

## Fork and deploy

About 15 minutes, all on free plans. You need:
- a GitHub account;
- a Cloudflare account;
- Python 3.11+ and Node.js 20+ on the PC you play on;
- Minecraft Java with [Fabric Loader](https://fabricmc.net/use/installer/) and [Fabric API](https://modrinth.com/mod/fabric-api).

1. **Fork this repository and clone your fork** onto the PC you play on.
2. **Build the mod once:** in your fork, go to *Actions* → *Release mod* → *Run workflow*. For a proper release, push a tag matching `mod/gradle.properties`, e.g. `git tag v1.0.4 && git push --tags`.
3. **Run the wizard** from the clone:
   ```bash
   python setup.py
   ```
   It works through these steps, asking before each:
   1. deploys the Worker (a browser opens to log in to Cloudflare);
   2. generates the push token and invite key, and stores them as Worker secrets;
   3. writes `agent/config.toml`;
   4. installs the agent's packages and starts it at login;
   5. downloads the mod from your fork's release;
   6. prints your invite link.
4. **Set two repository variables** (the wizard prints the values): *Settings → Secrets and variables → Actions → Variables*: `MCS_API_URL` (your Worker's URL) and `MCS_SITE_NAME`. If you have the [gh CLI](https://cli.github.com/), the wizard sets them itself.
5. **Turn on Pages:** *Settings → Pages → Source: GitHub Actions*. Then *Settings → Environments → github-pages → Deployment branches*: add `map`.
6. **Push to `main`** (or re-run the *Deploy site* workflow). Open your invite link.

To use your own domain, point the page at it in the Pages settings. Enter a
subdomain of a Cloudflare-managed domain as the Worker URL, e.g.
`status-api.example.com`; the route is added on deploy.

**Later:**

| Command | What it does |
| --- | --- |
| `python setup.py invite` | New invite link; everyone on the old one is disconnected |
| `python setup.py token` | New push token for the agent |
| `python setup.py deploy` | Deploy Worker changes from your PC |
| `python setup.py autostart` | Reinstall the agent's autostart |
| `python agent/agent.py --dry-run` | Print exactly what would be published |

**Deploying the Worker from GitHub instead** is optional. Add these repository
secrets and pushes to `worker/` deploy it:
- `CLOUDFLARE_API_TOKEN` (created from the "Edit Cloudflare Workers" template);
- `CLOUDFLARE_ACCOUNT_ID`;
- `PUSH_TOKEN` and `VIEW_KEY` (the wizard sets these if `gh` is installed).

Without them, that workflow skips itself.

### Staying free

Going over a limit makes requests fail until 00:00 UTC; nothing is ever billed.

| Service | Free limit | This uses |
| --- | --- | --- |
| Workers requests | 100,000/day | the agent pushes about 8,600/day if you play all day and 1,440/day while away; each viewer costs about one request per visit |
| Durable Object storage writes | 100,000/day | one per push, plus one per frame and one per logout panorama |
| GitHub Actions | unlimited on public repos | one deploy per logout render or push to `main` |
| GitHub Pages | 1 GB site, 100 GB/month | about 10 MB for the map and page |

**Durable Object instead of KV.** State lives in a SQLite-backed Durable Object
because KV's free plan allows only 1,000 writes a day. An agent pushing every
10 s would use that up in under three hours.

**Viewers don't poll.** The page and the map open one WebSocket, and each push
is broadcast over it:
- Opening the socket costs one request.
- Messages sent to viewers and the keep-alive pings are free.
- A tab left open all day costs about as much as one page load.
- Hidden tabs disconnect after a minute.

The panorama is fetched only by viewers who see it, and then it's cached.

### Who can watch

- **Invite link only.** Live data needs the key from `<your site>/#key=…`. The
  page remembers it on that device and removes it from the address bar.
  Visitors without it see a form to enter a key.
- **At most 10 at once.** The 11th viewer sees "too many people are watching".
  Change `MAX_VIEWERS` in `worker/worker.js` to adjust.
- **Not protected:** the rendered map tiles under `/map`. They are static files
  in your public repo, so anyone who finds the URL sees the terrain around your
  last logout, just without markers.

## Installing without the wizard

Everything the wizard does can be done by hand:

- **Worker.** Run `cd worker && npx wrangler deploy` (workers.dev), or
  `python setup.py worker-config` then `npx wrangler deploy -c wrangler.generated.toml`
  for a custom domain. Set both secrets with `npx wrangler secret put PUSH_TOKEN`
  and `VIEW_KEY`, using long random values.
- **Agent.**
  1. Run `python -m venv agent/.venv`, then `agent/.venv/bin/pip install -r agent/requirements.txt` (use `Scripts\` on Windows).
  2. Copy `agent/config.example.toml` to `agent/config.toml` and fill in `[worker]`.
  3. Run `agent.py --dry-run`, then `agent.py --log-file agent.log`.
- **Mod.** Take the jar from your fork's Releases, or run
  `cd mod && ./gradlew build` (Java 25). Put it in `.minecraft/mods` next to
  Fabric API.

### Mod settings

The mod writes `config/mc-status.properties` on first start:

```properties
capture_interval_seconds=60   # how often the live frame updates
capture_width=1920
state_interval_ticks=20       # how often state.json is checked (20 = 1 s)
share_item_names=false        # custom item names can contain anything
```

## The mod

It shares everything through files in `.minecraft/mc-status/`.

**`state.json`**
- **Contents:** vitals, all inventory slots with durability and enchantments, position, FPS and game memory. In singleplayer it also has world facts, statistics, advancements and your last death spot; these are read on the integrated server's thread every 10 s.
- **Writing:** it's rewritten when something changes, and at least every 5 s. It goes to a temp file first and then swaps into place (retried while the agent has it open).
- **On logout:** it's marked `online: false` and keeps your last state.

**`latest.png`**
- **What:** a frame of the world, taken after the world is drawn but before the HUD, so chat never appears in it.
- **When:** every 60 s, and when the pause menu opens.

**`panorama.png` and `panorama.json`**
- **What:** six 1024² faces (front, right, back, left, up, down) in one strip. They use the same panoramic camera mode as vanilla's panorama screenshots.
- **When:** as the pause menu opens in singleplayer, at most every 2 minutes. Save & Quit always goes through that menu, and the game is paused, so the six extra world renders happen out of sight.
- **Upload:** the agent uploads it only after you log out.

**`commands/*.json`**
- **What:** how curses reach a singleplayer world, which has no RCON. The mod runs each file's commands and deletes the file.
- **Limits:** files older than a minute are dropped; they're ignored on servers.

### Why capturing doesn't lag

The game's own screenshot code reads back the whole frame and loops over every
pixel on the render thread. On Intel integrated graphics that froze the game
for about 600 ms.

The mod scales the frame on the GPU and reads it back asynchronously. The copy
out of the driver's memory runs on a background thread (`GpuReadback`), so
about 1 ms is spent on the render thread.

### Multiplayer

On someone else's server the page shows that you're playing, plus your vitals
and inventory. The mod never collects the rest there, and the agent drops it too:
- coordinates;
- the frame and the panorama;
- the world card, statistics and advancements;
- map markers and the logout map;
- curses.

The server's address is never written anywhere.

## The map

The map at `/map` is a BlueMap 3D render of the area around where you last
logged out. When you log out, the agent:
1. waits for the save to finish;
2. renders an 8-chunk radius around your position with `map/render.py`;
3. force-pushes the result to the `map` branch as a single commit, so the map
   stays around 10 MB and history never grows.

Turn it on in `agent/config.toml`:

```toml
[map]
render_on_logout = true
accept_mojang_eula = true   # BlueMap downloads textures from the client jar
```

`render.py` needs Java 25+; it uses the Java that ships with the Minecraft
launcher. It also needs git push access from your clone.

To render by hand:

```bash
python map/render.py --world "path/to/saves/My World" --center 120 -40 --accept-mojang-eula --publish
```

`--publish-only` re-publishes the last render along with any changed map
scripts.

BlueMap normally polls for markers every second. `map/live-feed.js` switches
that off and feeds the player marker and the death marker from the page's
WebSocket instead. It relies on BlueMap internals, so check the markers after
bumping `BLUEMAP_VERSION`.

## Cursed mode

The machine reaches into the world:
- a busy GPU sets the ground around you on fire;
- low RAM makes you slow;
- 12 hours of uptime tells you to go to bed.

It's off by default. Rules are plain commands:

```toml
[[cursed.rules]]
name = "gpu on fire"
when = "gpu_percent >= 95"   # cpu_percent gpu_percent mem_percent uptime_hours health foodlevel xplevel (+ cpu_temp gpu_temp with fastfetch)
cooldown_seconds = 120
commands = ['execute at {player} run fill ~-2 ~ ~-2 ~2 ~ ~2 minecraft:fire replace minecraft:air']
```

A rule fires when its condition becomes true, then again every
`cooldown_seconds` while it stays true, and only while you're in a singleplayer
world (or on your RCON server).

**Fire kills.** Use long cooldowns and try rules on a copy of your world.

## Running on a server you own

1. Set `source.type = "rcon"` and fill in `[rcon]`.
2. Enable RCON in `server.properties` and keep it on localhost; it's an unencrypted console.
3. For logout renders, set `map.world` to the server's world folder.

Without the mod there's no frame, unless `screenshot.directory` points at a
folder. `python setup.py autostart` installs a systemd user service on Linux
and a launchd agent on macOS.

## Development

```bash
python tests/test_agent_mod.py     # mod source, logout render, panorama, play time, privacy
python tests/test_curses.py        # curse rules over RCON
node tests/test_worker.mjs         # Worker routes and broadcasts
```

All three also run in the *Tests* workflow. `tests/README.md` covers the
WebSocket test against `wrangler dev`.

**Page code:**
- `site/js/main.js` builds the view out of sections that are only rebuilt when their data changes.
- `gui.js` draws the game GUIs pixel-exact at any display scaling.
- `panorama.js` is the CSS 3D cube.
- `site/js/config.js` is rewritten at deploy from the repository variables.

**Build the icons locally:** `pip install Pillow && python site/build_assets.py`.

## Minecraft assets

The page draws real item icons, HUD sprites and the inventory screen. The
[Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines)
allow that for fan sites that meet three conditions.

- **Show their disclaimer.** "NOT AN OFFICIAL MINECRAFT WEBSITE. NOT APPROVED BY
  OR ASSOCIATED WITH MOJANG OR MICROSOFT." It's in the page footer and on the
  map. Keep it if you restyle either.
- **Don't look official.**
- **Don't redistribute game files.** Nothing from the game is committed. At
  deploy, `site/build_assets.py` downloads the client jar from Mojang
  (checksum-verified). It renders the icons, sprites, font and English names
  into the gitignored `site/assets/mc/`.

**After a Minecraft update:**
1. Bump `MC_VERSION` in `site/build_assets.py` and the versions in `mod/gradle.properties`.
2. For RCON, regenerate `agent/max_durability.json` with `agent/update_durability.py`.

## Privacy

Published: what the page shows, nothing more.

**Never read or sent:**
- local IP, hostname and user name;
- the world seed and the world's folder;
- chat, and the servers you join;
- custom item names (unless `share_item_names` is on);
- any field that isn't on an explicit allowlist, so a Minecraft update can't
  quietly start leaking something.

**Third parties visitors' browsers talk to:**
- `mc-heads.net` for your skin (the page falls back to the game's player head);
- Google Fonts for the Noto Sans typeface.

**Decide for yourself:**
- **Coordinates.** `privacy.hide_coordinates = true` removes them from the
  page, the map marker and the death marker. The logout map still shows the
  area, so turn `render_on_logout` off too if that matters.
- **The logout map and panorama** show everything around you, including builds.
- **World name, biome, statistics and hardware names** are on the page, for
  your own worlds only.

## License

MIT, see [LICENSE](LICENSE). Minecraft is a trademark of Mojang; this project
isn't affiliated with Mojang or Microsoft.
