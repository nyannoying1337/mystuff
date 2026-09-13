# Rendering the map

The site is a shell around a rendered Minecraft world map. The render happens on
your machine (it needs the world save, which lives there, not here); the site
just serves whatever you drop in.

## 1. Render the world

Grab [uNmINeD](https://unmined.net/downloads/) (free, no install — CLI or GUI).

```
unmined-cli web render \
  --world="%APPDATA%\.minecraft\saves\<world name>" \
  --output="static/map"
```

On macOS/Linux the save lives at `~/.minecraft/saves/<world name>` (or
`~/Library/Application Support/minecraft/saves/<world name>`).

That produces a self-contained Leaflet site — `index.html` plus a tile pyramid —
under `static/map/`. Vite's `publicDir` is `static`, so it gets served at `/map/`
and the page picks it up automatically.

Sanity-check it before deploying:

```
pnpm dev     # then open the site; the map should be there
```

## 2. Watch the size

Tile pyramids get big — a well-explored world can run to several GB and tens of
thousands of small files. That matters here because:

- GitHub Pages caps a published site at **1 GB**
- every file gets committed, so the repo and each Actions deploy grow with it

Crop the render to the part worth showing:

```
unmined-cli web render \
  --world="..." \
  --area="b(-2000,-2000,4000,4000)" \
  --output="static/map"
```

`b(x,z,width,height)` is in blocks, centred wherever you point it. Check the
output size with `du -sh static/map` before committing.

If it's still too big, host the tiles somewhere else (an R2 bucket on a
subdomain works well and has no egress fees) and point `src/map-config.js` at
it:

```js
export const MAP_URL = "https://map.nyannoying.de/index.html";
```

Nothing else needs to change — the page iframes whatever that URL is, and skips
the "not rendered yet" placeholder for non-relative URLs.

## 3. Updating it

The map is a **snapshot**, not live. No player positions, no automatic updates.
To refresh it, re-run the render over the same output folder and redeploy.
uNmINeD only redraws chunks that changed, so repeat renders are much faster than
the first.

## Wanting an actually-live map instead?

That needs a plugin running on the Minecraft server itself — BlueMap, squaremap
or Dynmap — serving its own web app with live player markers, exposed over HTTPS
(a Cloudflare Tunnel is the tidy way) and iframed here. Different setup; this
repo is only the static-render path.
