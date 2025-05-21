import { Hono } from 'hono'
import { cache } from 'hono/cache'
import { cors } from 'hono/cors'

type Bindings = {
    KV: KVNamespace
    STEAM_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

export type SteamResult = {
    totalHours: number,
    totalPlaytime: number,
    topGames: string[],
    lastPlayedGame: {
        name: string,
        lastPlayed: number
    }
}

app.use(cors())

app.get('/my-steam', async (c) => {
    const CACHE_KEY = "steam:profile"
    const CACHE_DURATION = 3600;

    const cachedRes = await c.env.KV.get<SteamResult>(CACHE_KEY, { type: "json" })

    if (cachedRes) {
        return c.json(cachedRes)
    }

    const STEAM_API_KEY = c.env.STEAM_API_KEY
    const STEAM_ID = '76561198045384584';
    const apiUrl = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${STEAM_ID}&include_appinfo=true&include_played_free_games=true&include_last_played=true`;

    const response = await fetch(apiUrl);

    if (!response.ok) {
        return c.json({
            error: true,
            status: response.status,
        })
    }

    const data = await response.json();

    const games = data.response.games;

    if (games.length === 0) {
        throw new Error('No games found in library');
    }

    // Calculate total playtime
    const totalPlaytime = games.reduce((total: number, game: any) => total + (game.playtime_forever || 0), 0);
    const totalHours = Math.round(totalPlaytime / 60); // Convert minutes to hours
    
    // Find the most recently played game
    const lastPlayedGame = games.reduce((latest: any, game: any) => {
        if (!latest || ((game.rtime_last_played || 0) > (latest.rtime_last_played || 0))) {
            return game;
        }
        return latest;
    }, null);

    // Sort games by playtime to get top games (names only)
    const topGames = games
        .sort((a: any, b: any) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
        .slice(0, 5)
        .map((game: any) => game.name);

    const result = { 
        totalHours, 
        totalPlaytime, 
        topGames,
        lastPlayedGame: lastPlayedGame && lastPlayedGame.rtime_last_played ? {
            name: lastPlayedGame.name,
            lastPlayed: lastPlayedGame.rtime_last_played
        } : null
    }

    await c.env.KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_DURATION })

    return c.json(result)
})

app.get('/my-steam-avatar', async (c) => {
    const CACHE_KEY = "steam:avatar"
    const CACHE_DURATION = 3600;

    const cachedRes = await c.env.KV.get<{ avatarUrl: string }>(CACHE_KEY, { type: "json" })

    if (cachedRes) {
        return c.json(cachedRes)
    }

    const STEAM_API_KEY = c.env.STEAM_API_KEY
    const STEAM_ID = '76561198045384584';
    const apiUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${STEAM_ID}`;

    const response = await fetch(apiUrl);

    if (!response.ok) {
        return c.json({
            error: true,
            status: response.status,
        })
    }

    const data = await response.json();
    const player = data.response.players[0];
    
    const result = { 
        avatarUrl: player.avatarfull // This gets the full-size avatar
    }

    await c.env.KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_DURATION })

    return c.json(result)
})

export default app