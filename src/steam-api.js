// Steam API configuration
const STEAM_API_KEY = import.meta.env.VITE_STEAM_API_KEY;
const STEAM_ID = '76561198045384584';

// Debug mode
const DEBUG = true;

function debugLog(...args) {
    if (DEBUG) {
        console.log('[Steam API Debug]', ...args);
    }
}

async function fetchSteamGames() {
    debugLog('Fetching Steam games...');
    const apiUrl = `https://api-ice.nyannoying.workers.dev/my-steam`;
    
    try {
        // Show loading state
        updateLoadingState(true);
        
        // Fetch owned games
        const response = await fetch(apiUrl);
        debugLog('Response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        /**
         * @type {import("../api/src/index").SteamResult}
         */
        const data = await response.json();
        
        // Update the stats
        updateStats(data.topGames.length, data.totalHours);
    } catch (error) {
        console.error('Error fetching Steam games:', error);
        showError(`Failed to fetch Steam games: ${error.message}`);
        // Set default values in case of error
        updateStats(0, 0);
    } finally {
        // Hide loading state
        updateLoadingState(false);
    }
}

function updateStats(gameCount, totalHours) {
    debugLog('Updating stats with:', { gameCount, totalHours });
    
    const gamesElement = document.querySelector('.stat-item:nth-child(2) .stat-value');
    const hoursElement = document.querySelector('.stat-item:nth-child(1) .stat-value');
    
    if (!gamesElement || !hoursElement) {
        debugLog('Error: Could not find stat elements in DOM');
        return;
    }
    
    gamesElement.textContent = `${gameCount}+`;
    hoursElement.textContent = `${totalHours}+`;
    
    debugLog('Stats updated successfully');
}

function updateLoadingState(isLoading) {
    debugLog('Updating loading state:', isLoading);
    
    const stats = document.querySelectorAll('.stat-value');
    if (stats.length === 0) {
        debugLog('Error: Could not find stat elements for loading state');
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
    
    debugLog('Loading state updated successfully');
}

function showError(message) {
    debugLog('Error:', message);
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
}); 