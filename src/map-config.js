// Where the rendered map lives.
//
// Default: a `map/` folder served from this site's own root. Drop the output of
// `unmined-cli web render --output=...` into `static/map/` and it lands at /map/.
//
// Hosting the tiles elsewhere instead (R2 bucket, subdomain, whatever)? Put the
// full URL of its index.html here and nothing else needs to change:
//
//   export const MAP_URL = "https://map.nyannoying.de/index.html";
//
export const MAP_URL = "map/index.html";

// Shown over the map. Purely cosmetic.
export const MAP_TITLE = "the world";
export const MAP_SUBTITLE = "rendered with uNmINeD";
