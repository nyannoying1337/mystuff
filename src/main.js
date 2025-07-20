import data from "./index.html?raw"
import "./styles.css"
import "./script.js"
import "./steam-api.js"

function setTheme(theme) {
  document.body.classList.remove('theme-green', 'theme-amber', 'theme-blue', 'theme-magenta');
  document.body.classList.add('theme-' + theme);
  localStorage.setItem('terminal-theme', theme);
}

document.addEventListener('DOMContentLoaded', () => {
  // Restore theme
  const saved = localStorage.getItem('terminal-theme') || 'green';
  setTheme(saved);
  // Theme switcher
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => setTheme(btn.dataset.theme));
  });
});

document.querySelector("#site").innerHTML = data;