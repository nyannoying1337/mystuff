import { MAP_URL } from "./map-config.js";

// A relative MAP_URL is served from our own origin, so we can HEAD it to find
// out whether the tiles have actually been dropped in yet. A cross-origin URL
// can't be probed (CORS), so we just trust it and mount.
const isSameOrigin = !/^https?:\/\//i.test(MAP_URL);

async function mapExists() {
    if (!isSameOrigin) return true;
    try {
        const res = await fetch(MAP_URL, { method: "HEAD" });
        return res.ok;
    } catch {
        return false;
    }
}

function mount(stage) {
    const frame = document.createElement("iframe");
    frame.className = "map-frame";
    frame.src = MAP_URL;
    frame.title = "Minecraft world map";
    frame.loading = "lazy";
    frame.addEventListener("load", () => frame.classList.add("loaded"));
    stage.appendChild(frame);
}

function showSetupHint(stage) {
    stage.classList.add("map-stage-empty");
    stage.innerHTML = `
        <div class="map-placeholder">
            <i class="fas fa-map-location-dot map-placeholder-icon"></i>
            <h2 class="map-placeholder-title">no map rendered yet</h2>
            <p class="map-placeholder-text">
                Render the world with uNmINeD, then drop the output into
                <code>static/map/</code> and redeploy.
            </p>
            <pre class="map-placeholder-code"><code>unmined-cli web render \\
  --world="&lt;path to world save&gt;" \\
  --output="static/map"</code></pre>
            <p class="map-placeholder-note">
                See <code>MAP.md</code> in the repo for the full walkthrough.
            </p>
        </div>`;
}

export async function initMap() {
    const stage = document.getElementById("map-stage");
    if (!stage) return;

    if (await mapExists()) {
        mount(stage);
    } else {
        showSetupHint(stage);
    }
}
