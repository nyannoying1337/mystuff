const STEAM_API_URL   = 'https://api-ice.nyannoying.workers.dev/my-steam';
const STEAM_LEVEL_URL = 'https://api-ice.nyannoying.workers.dev/my-steam-level';

async function fetchSteamGames() {
    try {
        setSteamLoading(true);

        const [gamesRes, levelRes] = await Promise.all([
            fetch(STEAM_API_URL),
            fetch(STEAM_LEVEL_URL)
        ]);

        if (!gamesRes.ok) throw new Error(`HTTP ${gamesRes.status}`);

        /** @type {import("../api/src/index").SteamResult} */
        const data = await gamesRes.json();
        const steamLevel = levelRes.ok ? ((await levelRes.json()).steamLevel ?? null) : null;

        updateSteamStats(data.gameCount, data.totalHours, data.lastPlayedGame, steamLevel, data.topGames);
    } catch (err) {
        console.error('Steam API error:', err);
        setSteamError();
    } finally {
        setSteamLoading(false);
    }
}

function updateSteamStats(gameCount, totalHours, lastPlayedGame, steamLevel, topGames) {
    const hoursEl        = document.getElementById('steam-hours');
    const gamesEl        = document.getElementById('steam-games');
    const lastPlayedEl   = document.getElementById('steam-last-played');
    const lastPlayedLabel = document.getElementById('steam-last-played-label');
    const levelEl        = document.getElementById('steam-level-value');

    if (hoursEl) hoursEl.textContent = totalHours ? `${totalHours.toLocaleString()}+` : '—';
    if (gamesEl) gamesEl.textContent = gameCount  ? `${gameCount}+`  : '—';

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
        if (lastPlayedEl)    lastPlayedEl.textContent = '—';
        if (lastPlayedLabel) lastPlayedLabel.textContent = 'Last Played';
    }

    // Steam level badge
    if (levelEl) {
        levelEl.textContent = steamLevel != null ? steamLevel : '—';
        levelEl.classList.remove('loading');
    }

    // Top 3 most-played games
    const topGamesContainer = document.getElementById('steam-top-games');
    if (topGamesContainer && Array.isArray(topGames) && topGames.length > 0) {
        topGamesContainer.innerHTML = topGames.map((game, i) => `
            <div class="top-game-row">
                <span class="top-game-rank">#${i + 1}</span>
                <span class="top-game-name">${escapeHtml(game.name)}</span>
                <span class="top-game-hours">${game.hours.toLocaleString()}h</span>
            </div>
        `).join('');
    }
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function setSteamLoading(isLoading) {
    const ids = ['steam-hours', 'steam-games', 'steam-last-played', 'steam-level-value'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (isLoading) el.classList.add('loading');
            else           el.classList.remove('loading');
        }
    });
}

function setSteamError() {
    ['steam-hours', 'steam-games', 'steam-last-played', 'steam-level-value'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = '—'; el.classList.remove('loading'); }
    });
}

document.addEventListener('DOMContentLoaded', fetchSteamGames);
