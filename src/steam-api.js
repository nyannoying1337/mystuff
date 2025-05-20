// Steam API configuration
const STEAM_API_KEY = import.meta.env.VITE_STEAM_API_KEY;
const STEAM_ID = '76561198045384584';

// Debug mode
const DEBUG = false;

// CORS Proxy
const CORS_PROXY = 'https://corsproxy.io/?';

function debugLog(...args) {
    if (DEBUG) {
        console.log('[Steam API Debug]', ...args);
    }
}

async function fetchSteamGames() {
    debugLog('Fetching Steam games...');
    const apiUrl = `${CORS_PROXY}https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${STEAM_ID}&include_appinfo=true&include_played_free_games=true`;
    
    try {
        // Show loading state
        updateLoadingState(true);
        
        // Fetch owned games
        const response = await fetch(apiUrl);
        debugLog('Response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        debugLog('Raw API Response:', data);
        
        // Check for API errors
        if (data.error) {
            throw new Error(`Steam API Error: ${data.error.message || 'Unknown error'}`);
        }
        
        if (!data.response) {
            throw new Error('Invalid response format: missing response object');
        }
        
        if (!data.response.games) {
            throw new Error('No games found in response');
        }
        
        const games = data.response.games;
        debugLog('Number of games found:', games.length);
        
        if (games.length === 0) {
            throw new Error('No games found in library');
        }
        
        // Calculate total playtime
        const totalPlaytime = games.reduce((total, game) => total + (game.playtime_forever || 0), 0);
        const totalHours = Math.round(totalPlaytime / 60); // Convert minutes to hours
        
        debugLog('Total playtime (minutes):', totalPlaytime);
        debugLog('Total playtime (hours):', totalHours);
        
        // Update the stats
        updateStats(games.length, totalHours);
        
        // Show top 5 most played games
        const topGames = games
            .sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
            .slice(0, 5);
        
        debugLog('Top 5 most played games:', topGames.map(game => ({
            name: game.name,
            hours: Math.round((game.playtime_forever || 0) / 60)
        })));
        
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
    debugLog('Initializing Steam API...');
    if (!STEAM_API_KEY) {
        showError('Steam API key not configured');
        return;
    }
    if (!STEAM_ID) {
        showError('Steam ID not configured');
        return;
    }
    fetchSteamGames();
}); 