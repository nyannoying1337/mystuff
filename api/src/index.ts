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
    topGames: string[]
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
    const apiUrl = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${STEAM_ID}&include_appinfo=true&include_played_free_games=true`;

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
    const totalPlaytime = games.reduce((total, game) => total + (game.playtime_forever || 0), 0);
    const totalHours = Math.round(totalPlaytime / 60); // Convert minutes to hours
    const topGames = games
  


    const result = { totalHours, totalPlaytime, topGames }

    await c.env.KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_DURATION })

    return c.json(result)
})

export default app