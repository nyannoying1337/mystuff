// Steam API configuration
const STEAM_API_KEY = import.meta.env.VITE_STEAM_API_KEY;
const STEAM_ID = '76561198045384584';

async function fetchSteamGames() {
    const apiUrl = `https://api-ice.nyannoying.workers.dev/my-steam`;
    
    try {
        // Show loading state
        updateLoadingState(true);
        
        // Fetch owned games
        const response = await fetch(apiUrl);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        /**
         * @type {import("../api/src/index").SteamResult}
         */
        const data = await response.json();
        
        // Update the stats
        updateStats(data.topGames.length, data.totalHours, data.lastPlayedGame);
    } catch (error) {
        console.error('Error fetching Steam games:', error);
        showError(`Failed to fetch Steam games: ${error.message}`);
        // Set default values in case of error
        updateStats(0, 0, null);
    } finally {
        // Hide loading state
        updateLoadingState(false);
    }
}

async function fetchSteamAvatar() {
    const apiUrl = `https://api-ice.nyannoying.workers.dev/my-steam-avatar`;
    
    try {
        const response = await fetch(apiUrl);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Update the avatar
        const avatarInner = document.querySelector('.avatar-inner');
        if (avatarInner) {
            avatarInner.style.backgroundImage = `url(${data.avatarUrl})`;
            avatarInner.style.backgroundSize = 'cover';
            avatarInner.style.backgroundPosition = 'center';
        }
    } catch (error) {
        console.error('Error fetching Steam avatar:', error);
    }
}

function updateStats(gameCount, totalHours, lastPlayedGame) {
    const gamesElement = document.querySelector('.stat-item:nth-child(2) .stat-value');
    const hoursElement = document.querySelector('.stat-item:nth-child(1) .stat-value');
    const lastPlayedElement = document.querySelector('.stat-item:nth-child(3) .stat-value');
    const lastPlayedLabel = document.querySelector('.stat-item:nth-child(3) .stat-label');
    
    if (!gamesElement || !hoursElement || !lastPlayedElement || !lastPlayedLabel) {
        return;
    }
    
    gamesElement.textContent = `${gameCount}+`;
    hoursElement.textContent = `${totalHours}+`;
    
    if (lastPlayedGame) {
        const lastPlayedDate = new Date(lastPlayedGame.lastPlayed * 1000);
        const now = new Date();
        const diffTime = Math.abs(now - lastPlayedDate);
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        
        let timeAgo;
        if (diffDays === 0) {
            timeAgo = 'Today';
        } else if (diffDays === 1) {
            timeAgo = 'Yesterday';
        } else if (diffDays < 7) {
            timeAgo = `${diffDays} days ago`;
        } else {
            timeAgo = lastPlayedDate.toLocaleDateString();
        }
        
        lastPlayedElement.textContent = lastPlayedGame.name;
        lastPlayedLabel.textContent = `Last played ${timeAgo}`;
    } else {
        lastPlayedElement.textContent = 'N/A';
        lastPlayedLabel.textContent = 'Last played';
    }
}

function updateLoadingState(isLoading) {
    const stats = document.querySelectorAll('.stat-value');
    if (stats.length === 0) {
        return;
    }
    
    stats.forEach(stat => {
        if (isLoading) {
            stat.textContent = '...';
            stat.style.opacity = '0.5';
        } else {
            stat.style.opacity = '1';
        }
    });
}

function showError(message) {
    // Add visual error feedback
    const stats = document.querySelectorAll('.stat-value');
    stats.forEach(stat => {
        stat.textContent = 'Error';
        stat.style.color = '#ff4444';
    });
}

// Initialize Steam data when the page loads
document.addEventListener('DOMContentLoaded', () => {
    fetchSteamGames();
    fetchSteamAvatar();
}); 