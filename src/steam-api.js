const STEAM_ID = '76561198045384584';

async function fetchSteamGames() {
    const apiUrl = `https://api-ice.nyannoying.workers.dev/my-steam`;

    try {
        setSteamLoading(true);

        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        /** @type {import("../api/src/index").SteamResult} */
        const data = await response.json();
        updateSteamStats(data.topGames.length, data.totalHours, data.lastPlayedGame);
    } catch (err) {
        console.error('Steam API error:', err);
        setSteamError();
    } finally {
        setSteamLoading(false);
    }
}

function updateSteamStats(gameCount, totalHours, lastPlayedGame) {
    const hoursEl = document.getElementById('steam-hours');
    const gamesEl = document.getElementById('steam-games');
    const lastPlayedEl = document.getElementById('steam-last-played');
    const lastPlayedLabel = document.getElementById('steam-last-played-label');

    if (hoursEl) hoursEl.textContent = totalHours ? `${totalHours.toLocaleString()}+` : '—';
    if (gamesEl) gamesEl.textContent = gameCount ? `${gameCount}+` : '—';

    if (lastPlayedGame && lastPlayedEl) {
        const lastPlayedDate = new Date(lastPlayedGame.lastPlayed * 1000);
        const now = new Date();
        const diffDays = Math.floor((now - lastPlayedDate) / (1000 * 60 * 60 * 24));

        let timeAgo;
        if (diffDays === 0)       timeAgo = 'Today';
        else if (diffDays === 1)  timeAgo = 'Yesterday';
        else if (diffDays < 7)    timeAgo = `${diffDays} days ago`;
        else                      timeAgo = lastPlayedDate.toLocaleDateString();

        lastPlayedEl.textContent = lastPlayedGame.name;
        if (lastPlayedLabel) lastPlayedLabel.textContent = `Last played ${timeAgo}`;
    } else {
        if (lastPlayedEl) lastPlayedEl.textContent = '—';
        if (lastPlayedLabel) lastPlayedLabel.textContent = 'Last Played';
    }
}

function setSteamLoading(isLoading) {
    const ids = ['steam-hours', 'steam-games', 'steam-last-played'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (isLoading) el.classList.add('loading');
            else           el.classList.remove('loading');
        }
    });
}

function setSteamError() {
    ['steam-hours', 'steam-games', 'steam-last-played'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = '—'; el.classList.remove('loading'); }
    });
}

document.addEventListener('DOMContentLoaded', fetchSteamGames);
