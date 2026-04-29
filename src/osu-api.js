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
    setText('osu-global-rank', data.globalRank ? data.globalRank.toLocaleString() : '—');
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

    // Update cover image with osu! profile cover
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

    // Profile meta row: follower count, join date, ranked score, title
    const metaRow = document.getElementById('profile-meta-row');
    if (metaRow) {
        if (data.followerCount != null) {
            setText('osu-follower-count', data.followerCount.toLocaleString());
        }
        if (data.joinDate) {
            const formatted = new Date(data.joinDate).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            setText('osu-join-date', `Joined ${formatted}`);
        }
        if (data.rankedScore) {
            setText('osu-ranked-score', data.rankedScore.toLocaleString());
        }
        if (data.title) {
            const titleEl = document.getElementById('osu-title-badge');
            if (titleEl) {
                titleEl.textContent = data.title;
                titleEl.style.display = '';
            }
        }
        metaRow.style.display = '';
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
                 'osu-level', 'osu-playcount', 'osu-playtime', 'osu-maxcombo',
                 'osu-follower-count', 'osu-join-date', 'osu-ranked-score'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (isLoading) el.classList.add('loading');
            else           el.classList.remove('loading');
        }
    });
}

function setOsuError() {
    const ids = ['osu-global-rank', 'osu-country-rank', 'osu-pp', 'osu-accuracy',
                 'osu-level', 'osu-playcount', 'osu-playtime', 'osu-maxcombo',
                 'osu-follower-count', 'osu-join-date', 'osu-ranked-score'];
    ids.forEach(id => setText(id, '—'));
}

function removeLoading() {
    document.querySelectorAll('.loading').forEach(el => el.classList.remove('loading'));
}

document.addEventListener('DOMContentLoaded', fetchOsuStats);

const OSU_RECENT_URL = 'https://api-ice.nyannoying.workers.dev/my-osu-recent';

async function fetchOsuRecent() {
    try {
        const response = await fetch(OSU_RECENT_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const plays = await response.json();
        renderOsuRecent(plays);
    } catch (err) {
        console.error('osu! recent plays error:', err);
        const container = document.getElementById('osu-recent-plays');
        if (container) container.innerHTML = '<div class="recent-play-row"><span class="recent-play-rank">—</span><div class="recent-play-info"><span class="recent-play-title">Failed to load</span></div></div>';
    }
}

function renderOsuRecent(plays) {
    const container = document.getElementById('osu-recent-plays');
    if (!container) return;
    if (!Array.isArray(plays) || plays.length === 0) {
        container.innerHTML = '<div class="recent-play-row"><span class="recent-play-meta" style="padding:0.75rem 1.5rem">No recent plays</span></div>';
        return;
    }
    container.innerHTML = plays.map(play => {
        const rankClass = `rank-${play.rank.toLowerCase()}`;
        const mods = play.mods.length > 0 ? play.mods.join(' ') : '';
        const ppText = play.pp != null ? `${play.pp.toLocaleString()}pp` : '';
        const meta = [play.accuracy + '%', ppText, mods].filter(Boolean).join(' · ');
        const timeAgo = formatTimeAgo(play.playedAt);
        return `<div class="recent-play-row">
            <span class="recent-play-rank ${rankClass}">${escapeHtml(play.rank)}</span>
            <div class="recent-play-info">
                <span class="recent-play-title">${escapeHtml(play.beatmapArtist)} - ${escapeHtml(play.beatmapTitle)} [${escapeHtml(play.difficultyName)}]</span>
                <span class="recent-play-meta">${escapeHtml(meta)}</span>
            </div>
            <span class="recent-play-time">${escapeHtml(timeAgo)}</span>
        </div>`;
    }).join('');
}

function formatTimeAgo(isoString) {
    if (!isoString) return '';
    const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', fetchOsuRecent);
