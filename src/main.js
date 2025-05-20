import data from "./index.html?raw"
import "./styles.css"
import "./script.js"
import "./steam-api.js"
import { setupCounter } from "./counter.js"

document.querySelector("#site").innerHTML = data;

setupCounter(document.querySelector("#counter"))