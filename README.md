# mc-status

A live status page for your Minecraft session and the machine it runs on, hosted
free on GitHub Pages. Your PC pushes; the page pulls. Nothing inbound, so it
works fine behind a captive portal.

```
          your PC                           Cloudflare Worker        GitHub Pages
┌─────────────────────────────┐   POST    ┌────────────────┐  GET  ┌──────────────┐
│ Minecraft + mc-status mod   │           │ /status /shot  │ ◀──── │ status page  │
│   writes state.json,        │           │ /bluemap/…     │       │ /map         │
│   latest.png; runs curses   │           │ + Durable Obj. │       └──────▲───────┘
│        ▲ commands  │ files  │           └───────▲────────┘              │
│        │           ▼        │                   │                       │
│ agent.py ───────────────────┼───────────────────┘                       │
│   fastfetch, curse rules,   │                                           │
│   on logout: map/render.py ─┼──▶ `map` branch ─────────────────────────┘
└─────────────────────────────┘
```

| Folder | What it is |
| --- | --- |
| `mod/` | Fabric client mod: shares your state and a small frame of the world, runs curses |
| `agent/` | Python agent: reads the mod's files, adds system stats, pushes, renders the map on logout |
| `worker/` | Cloudflare Worker: stores the latest push, serves it to the page and the map |
| `site/` | The status page |
| `map/` | BlueMap render + publish script |

## What shows up

- **In game:** the real HUD (hearts, hunger, XP and level, hotbar), your full
  inventory on the inventory screen with tooltips, coordinates, and a recent
  frame of the world.
- **Logged out:** when and where you were last seen, what you logged out with,
  and a 3D map of the area around that spot with a marker on it.
- **Always:** the machine's fastfetch line-up and any curses that fired
  recently.

## Setup (singleplayer on Windows)

About 30 minutes. The account steps (Cloudflare login, Fabric installer) are
yours to click through.

### 1. The Worker

```bash
cd worker
npx wrangler login
npx wrangler deploy
cd ..
powershell -ExecutionPolicy Bypass -File setup-token.ps1
powershell -ExecutionPolicy Bypass -File setup-view-key.ps1
```

`setup-token.ps1` generates a random push token and stores it as the Worker's
`PUSH_TOKEN` secret. It also writes the token into `agent/config.toml` and
checks that the Worker accepts it. The token is never printed. Run it again to
rotate the token.

`setup-view-key.ps1` creates the invite key and prints the invite link (see
[Who can watch](#who-can-watch)).

`wrangler.toml` routes it at `status-api.nyannoying.de`. Cloudflare creates that
DNS record on deploy, because the domain's DNS is on Cloudflare.

**Staying free.** Everything here fits the free plans; going over a limit
makes requests fail until 00:00 UTC, it never bills you.

| Service | Free limit | This setup uses |
| --- | --- | --- |
| Workers requests | 100,000/day | agent: ~8,600/day if you play all day, 1,440/day while away; viewers: about one per page load or reconnect, not per update |
| Durable Object requests | 100,000/day | the same pushes, plus one per viewer connection |
| Storage writes | 100,000/day (SQLite Durable Object) | one per push |
| GitHub Actions | unlimited on public repos | one deploy per logout or push to `main` |
| GitHub Pages | 1 GB site, 100 GB/month bandwidth | ~10 MB map + page |

State lives in a SQLite-backed Durable Object rather than KV on purpose: KV's
free plan allows only 1,000 writes a day, which an agent pushing every 10 s
uses up in under three hours.

Viewers don't poll. The page and the map open one WebSocket to that Durable
Object, and every push from the agent is broadcast over it. On Cloudflare,
opening the socket costs one request. Messages sent to viewers and the
keep-alive pings are free, so a tab left open all day costs about the same as
one page load. Hidden tabs disconnect after a minute and reconnect when you look
again.

### Who can watch

- **Invite link only.** Live data (status, inventory, position, screenshot, the
  map marker) needs the key from `nyannoying.de/#key=…`. The page remembers it
  on that device and removes it from the address bar. Without it, the page says
  it's private and makes no requests at all.
- **At most 10 at once.** The 11th viewer sees "too many people are watching",
  with a Try again button. Change `MAX_VIEWERS` in `worker/worker.js` and
  `site/index.html` to adjust.
- **Rotating** with `setup-view-key.ps1` disconnects everyone on the old link.

What the key does **not** protect: the rendered map tiles under `/map` are
static files in this public repo. Anyone who finds that URL sees the terrain
around your last logout, just without the marker. Hiding those would need a
private repo with Pages, which isn't free on GitHub.

### 2. The mod

1. Install [Fabric Loader](https://fabricmc.net/use/installer/) for Minecraft 26.2.
2. Put [Fabric API](https://modrinth.com/mod/fabric-api) and the mc-status jar in
   `%APPDATA%\.minecraft\mods`.
   - **Get the jar:** the repo's *Actions* tab → *Build mod* → latest run →
     *mc-status-mod* artifact.
   - **Or build it:** `cd mod && gradlew build` (Java 25). The jar lands in
     `mod/build/libs/`.
3. Start the game once. The mod writes `config/mc-status.properties`:

```properties
capture_interval_seconds=60   # how often "last thing seen" updates
capture_width=640
state_interval_ticks=20       # how often state.json is refreshed (20 = 1 s)
share_item_names=false        # custom item names can contain anything
```

### 3. The agent

```bash
cd agent
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python agent.py --dry-run
```

`setup-token.ps1` already created `config.toml` with the token. Leave
`source.type = "mod"`.

Check `--dry-run` before anything goes public: it prints exactly what would be
published. Start a world and run it again to see your inventory come through.

To run it at every login, with no console window and logs in `agent/agent.log`:

```bash
powershell -ExecutionPolicy Bypass -File agent\install-windows.ps1
```

Optional: `winget install fastfetch` for the machine panel. On Windows it often
can't read CPU/GPU temperatures, so temperature curses may never fire there.

### 4. The page

The `pages.yml` workflow deploys `site/` on every push to `main` or `map`.
Under Settings → Pages, set the source to *GitHub Actions*. Enforce HTTPS while
you're there.

Also allow the map branch to deploy: Settings → Environments → github-pages →
Deployment branches → add `map`. Without it, logout maps are pushed but never
go live.

## The mod

Everything it shares goes through files in `%APPDATA%\.minecraft\mc-status\`:

- **`state.json`:** health, hunger, XP, hotbar, all 27 inventory slots, armor,
  offhand (with durability and enchantments), position, dimension. Rewritten when
  something changes, and at least every 5 seconds. Written to a temp file and
  moved into place, so it's never half-written. On logout it's marked
  `online: false` and keeps the last inventory.
- **`latest.png`:** a 640px frame of the world, taken after the world is drawn
  but before the HUD, so chat and coordinates never appear in it. Captured every
  60 s, and when you open the pause menu (which covers Save & Quit).
- **`commands/*.json`:** how curses reach a singleplayer world, which has no
  RCON. The mod runs each file's commands as the integrated server, then deletes
  the file. At most 20 commands per file. Ignored on multiplayer servers.

### Why the capture doesn't lag

The first version used the game's screenshot code. That reads back the whole
frame and loops over every pixel on the render thread. Measured on Intel
integrated graphics at 854×480, it froze the game for about **600 ms** per
capture, worse at higher resolutions.

The mod now shrinks the frame on the GPU and reads back only 640×360. The slow
part, copying out of the driver's mapped memory (~45 ms on that GPU), runs on a
background thread. Frame times around a capture stay at their normal 5–10 ms.

## The map

A BlueMap 3D render of the area around where you last logged out, at `/map`.

When you log out, the agent:
1. waits for the world save to finish;
2. runs `map/render.py` for an 8-chunk radius around your position, only in
   that dimension;
3. force-pushes the result to the `map` branch as a single commit.

Each render replaces the previous one, so the map stays around 10 MB and git
history never grows. Pages redeploys and serves it under `/map`.

Enable it in `agent/config.toml`:

```toml
[map]
render_on_logout = true
radius_chunks = 8
accept_mojang_eula = true   # BlueMap downloads textures from the client jar
```

- **Java 25+:** nothing to install. The Minecraft launcher already ships Java 25
  for 26.2, and `render.py` finds it. Set `java =` to use a different one.
- **Git push access:** the clone the agent runs from needs it. Git Credential
  Manager handles this after one normal `git push`.

To render by hand:

```bash
python map/render.py --world "%APPDATA%\.minecraft\saves\My World" --center 120 -40 --dimension minecraft:overworld --accept-mojang-eula --publish
```

Without `--center` it renders the whole world. That's fine locally, but can
outgrow GitHub Pages' 1 GB limit on a big world.

While you're online, the map shows your live position; once you log out, a
"(last seen)" marker. BlueMap normally polls for markers every second.
`map/live-feed.js` switches that off and feeds the marker from the same
WebSocket as the page, using the invite key the page stored. It relies on
BlueMap internals, so check the marker after bumping `BLUEMAP_VERSION`.

## Cursed mode

The machine reaches into the world: a hot GPU sets the ground around you on
fire, a hot CPU brings a thunderstorm, low RAM makes you slow, and 12 hours of
uptime tells you to go to bed. Fired curses show up on the page.

It is off by default. Rules are plain Minecraft commands, so you can write your
own:

```toml
[[cursed.rules]]
name = "gpu on fire"
when = "gpu_temp >= 80"        # cpu_temp gpu_temp mem_percent uptime_hours health foodlevel xplevel
cooldown_seconds = 120
commands = ['execute at {player} run fill ~-2 ~ ~-2 ~2 ~ ~2 minecraft:fire replace minecraft:air']
```

A rule fires when its condition becomes true, then again every
`cooldown_seconds` while it stays true. Curses only run while you're in game.

**Fire kills.** In testing, a fire rule on a 60 s cooldown burned the player to
death and they dropped everything. Use long cooldowns, and try rules on a copy
of your world first.

## Running on a server instead

Set `source.type = "rcon"` and fill in `[rcon]`. Enable RCON in
`server.properties` and bind it to localhost only; it's an unencrypted remote
console.

```
enable-rcon=true
rcon.port=25575
rcon.password=something-long
```

Curses then go over RCON. For logout renders, set `map.world` to the server's
world folder. On Linux, `agent/mc-status-agent.service` runs the agent as a
systemd user service. Without the mod, there's no screenshot unless you point
`screenshot.directory` at a folder.

## Minecraft assets

The page draws real item icons, HUD sprites and the inventory screen. This is a
fan site presenting Minecraft information, which the
[Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines)
allow on three conditions: include their disclaimer, don't look official, and
don't redistribute game files.

- **Disclaimer:** "NOT AN OFFICIAL MINECRAFT WEBSITE. NOT APPROVED BY OR
  ASSOCIATED WITH MOJANG OR MICROSOFT." It's in the page footer and on the map.
  Keep it if you restyle either one.
- **Nothing from the game is committed.** At deploy, `site/build_assets.py`
  downloads the client jar from Mojang (checksum-verified), then renders every
  item icon (3D blocks included), the HUD and inventory sprites, and the item
  names into `site/assets/mc/`. The workflow publishes them with the site, and
  the folder is gitignored.
- **Local preview:** `pip install Pillow && python site/build_assets.py`. Pass
  `--jar` to reuse a client jar you already have.

Banners, shields, decorated pots, conduits, copper golem statues, dragon heads
and modded items show a coloured swatch; the game draws those with special
renderers. Chests, shulker boxes and mob heads are rebuilt as boxes.

After a Minecraft update:
1. Bump `MC_VERSION` in `site/build_assets.py`.
2. Update the versions in `mod/gradle.properties`.
3. For the RCON path, regenerate `agent/max_durability.json` with
   `python agent/update_durability.py --server-jar server.jar`.

## Privacy

Published: what the page shows, nothing more.

Never read or sent:
- local IP and hostname;
- chat;
- the local world path;
- custom item names (unless you turn `share_item_names` on);
- any field the mod or NBT adds that isn't on an explicit allowlist. So a
  Minecraft update can't quietly start leaking something.

Decide for yourself:

- **Coordinates.** Fine for a solo world. `privacy.hide_coordinates = true`
  hides them on the page and removes the map marker. The logout map still shows
  that area, so turn `render_on_logout` off too if that matters.
- **The map** shows everything within the rendered radius, including builds.
