import data from "./index.html?raw"
import "./styles.css"
import { renderPosts } from "./script.js"
import "./osu-api.js"
import "./steam-api.js"
import { posts } from "./posts.js"

document.querySelector("#site").innerHTML = data;

document.addEventListener('DOMContentLoaded', () => {
    renderPosts(posts);
});
