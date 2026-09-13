# mc-status

A live status page for your machine and your Minecraft session, hosted free on
GitHub Pages. Your PC pushes; the page pulls. Nothing inbound, so it works fine
behind a captive portal.

```
your PC                     Cloudflare Worker              GitHub Pages
┌──────────────┐   POST     ┌──────────────┐    GET      ┌──────────────┐
│ agent.py     │ ─────────▶ │ /status /shot│ ◀────────── │ index.html   │
│ fastfetch    │  every 20s │  + KV store  │  every 15s  │ your domain  │
│ RCON         │            └──────────────┘             └──────────────┘
│ screenshots/ │
└──────────────┘
```

## What shows up

Health and hunger with half-icons, XP bar and level, the full hotbar with stack
counts, durability bars and an enchant tint, coordinates, dimension, your most
recent in-game screenshot, and the usual fastfetch line-up. When the agent goes
quiet for 90 seconds the page swaps to a "connection lost" panel instead of
showing stale numbers.

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

To automate it later, a small Fabric client mod is about 80 lines: on client
tick, every ~15 seconds call `ScreenshotRecorder.saveScreenshot(...)`
overwriting a single `latest.png`, and let the agent keep doing the uploading.
Capturing at `DISCONNECT` doesn't work — the world is already being torn down
and there's no frame left to grab.

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
- **Screenshots.** They capture your HUD, which includes chat.

## Not yet built

- The Fabric mod (F2 works meanwhile)
- BlueMap export committed by an Action, with your live position as a marker on
  top of the static render
- The cursed version: system state driving the world, so a hot GPU sets things
  on fire
