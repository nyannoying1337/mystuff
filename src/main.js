import data from "./index.html?raw"
import "./styles.css"
import "./script.js"
import "./osu-api.js"
import "./steam-api.js"

document.querySelector("#site").innerHTML = data;
