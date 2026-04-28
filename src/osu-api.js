const OSU_API_URL = 'https://api-ice.nyannoying.workers.dev/my-osu';

async function fetchOsuStats() {
    try {
        setOsuLoading(true);

        const response = await fetch(OSU_API_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        /** @type {import("../api/src/index").OsuResult} */
        const data = await response.json();
        renderOsuStats(data);
    } catch (err) {
        console.error('osu! API error:', err);
        setOsuError();
    } finally {
        setOsuLoading(false);
    }
}

function renderOsuStats(data) {
    setText('osu-global-rank', data.globalRank ? `#${data.globalRank.toLocaleString()}`.replace('#', '') : '—');
    setText('osu-country-rank', data.countryRank ? data.countryRank.toLocaleString() : '—');
    setText('osu-pp', data.pp ? data.pp.toLocaleString() : '—');
    setText('osu-accuracy', data.accuracy ? `${data.accuracy}%` : '—');
    setText('osu-level', data.level ? `${data.level} (${data.levelProgress}%)` : '—');
    setText('osu-playcount', data.playCount ? data.playCount.toLocaleString() : '—');
    setText('osu-playtime', data.playTime ? formatPlayTime(data.playTime) : '—');
    setText('osu-maxcombo', data.maxCombo ? `${data.maxCombo.toLocaleString()}x` : '—');

    if (data.country) {
        const label = document.getElementById('osu-country-label');
        if (label) label.textContent = `${data.country} Rank`;
    }

    // Update cover if available
    if (data.coverUrl) {
        const cover = document.getElementById('cover-bg');
        if (cover) {
            cover.style.backgroundImage = `url(${data.coverUrl})`;
            cover.style.backgroundSize = 'cover';
            cover.style.backgroundPosition = 'center';
        }
    }

    // Update avatar with osu! avatar
    if (data.avatarUrl) {
        const avatar = document.getElementById('profile-avatar');
        if (avatar) avatar.src = data.avatarUrl;
    }

    removeLoading();
}

function formatPlayTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    if (hours >= 1000) return `${(hours / 1000).toFixed(1)}k hrs`;
    return `${hours.toLocaleString()} hrs`;
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = value;
        el.classList.remove('loading');
    }
}

function setOsuLoading(isLoading) {
    const ids = ['osu-global-rank', 'osu-country-rank', 'osu-pp', 'osu-accuracy',
                 'osu-level', 'osu-playcount', 'osu-playtime', 'osu-maxcombo'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (isLoading) {
                el.classList.add('loading');
            } else {
                el.classList.remove('loading');
            }
        }
    });
}

function setOsuError() {
    const ids = ['osu-global-rank', 'osu-country-rank', 'osu-pp', 'osu-accuracy',
                 'osu-level', 'osu-playcount', 'osu-playtime', 'osu-maxcombo'];
    ids.forEach(id => setText(id, '—'));
}

function removeLoading() {
    document.querySelectorAll('.loading').forEach(el => el.classList.remove('loading'));
}

document.addEventListener('DOMContentLoaded', fetchOsuStats);
