import data from "./index.html?raw"
import "./styles.css"
import { initMap } from "./map.js"
import { MAP_TITLE, MAP_SUBTITLE } from "./map-config.js"

document.querySelector("#site").innerHTML = data;

document.getElementById("map-title").textContent = MAP_TITLE;
document.getElementById("map-subtitle").textContent = MAP_SUBTITLE;

document.getElementById("map-fullscreen").addEventListener("click", e => {
    e.preventDefault();
    const shell = document.querySelector(".map-shell");
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        shell.requestFullscreen?.();
    }
});

initMap();
