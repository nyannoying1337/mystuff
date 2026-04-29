import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
    KV: KVNamespace
    STEAM_API_KEY: string
    OSU_CLIENT_ID: string
    OSU_CLIENT_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

export type SteamResult = {
    totalHours: number,
    totalPlaytime: number,
    gameCount: number,
    topGames: { name: string, hours: number }[],
    lastPlayedGame: {
        name: string,
        lastPlayed: number
    } | null
}

export type OsuResult = {
    username: string,
    avatarUrl: string,
    coverUrl: string | null,
    country: string,
    globalRank: number | null,
    countryRank: number | null,
    pp: number,
    accuracy: string,
    level: number,
    levelProgress: number,
    playCount: number,
    playTime: number,
    maxCombo: number,
    followerCount: number,
    joinDate: string | null,
    rankedScore: number,
    title: string | null,
}

app.use(cors())

async function getOsuToken(env: Bindings): Promise<string> {
    const CACHE_KEY = "osu:token"
    const cached = await env.KV.get(CACHE_KEY)
    if (cached) return cached

    const response = await fetch('https://osu.ppy.sh/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: Number(env.OSU_CLIENT_ID),
            client_secret: env.OSU_CLIENT_SECRET,
            grant_type: 'client_credentials',
            scope: 'public'
        })
    })

    if (!response.ok) {
        const errBody = await response.text()
        throw new Error(`osu! OAuth failed (${response.status}): ${errBody}`)
    }

    const data = await response.json() as { access_token: string, expires_in: number }
    if (!data.access_token) {
        throw new Error(`osu! OAuth: missing access_token in response`)
    }

    await env.KV.put(CACHE_KEY, data.access_token, { expirationTtl: data.expires_in - 60 })
    return data.access_token
}

app.get('/my-osu', async (c) => {
    const CACHE_KEY = "osu:profile"
    const CACHE_DURATION = 3600

    const cached = await c.env.KV.get<OsuResult>(CACHE_KEY, { type: "json" })
    if (cached) return c.json(cached)

    const token = await getOsuToken(c.env)
    const OSU_USER_ID = '7486592'

    const response = await fetch(`https://osu.ppy.sh/api/v2/users/${OSU_USER_ID}/osu`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'x-api-version': '20220705'
        }
    })

    if (!response.ok) {
        return c.json({ error: true, status: response.status }, response.status as any)
    }

    const data = await response.json() as any

    const result: OsuResult = {
        username: data.username,
        avatarUrl: data.avatar_url,
        coverUrl: data.cover?.url ?? null,
        country: data.country?.code ?? '',
        globalRank: data.statistics?.global_rank ?? null,
        countryRank: data.statistics?.country_rank ?? null,
        pp: Math.round(data.statistics?.pp ?? 0),
        accuracy: (data.statistics?.hit_accuracy ?? 0).toFixed(2),
        level: data.statistics?.level?.current ?? 0,
        levelProgress: data.statistics?.level?.progress ?? 0,
        playCount: data.statistics?.play_count ?? 0,
        playTime: data.statistics?.play_time ?? 0,
        maxCombo: data.statistics?.maximum_combo ?? 0,
        followerCount: data.follower_count ?? 0,
        joinDate: data.join_date ?? null,
        rankedScore: data.statistics?.ranked_score ?? 0,
        title: data.title ?? null,
    }

    await c.env.KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_DURATION })
    return c.json(result)
})

app.get('/my-steam', async (c) => {
    const CACHE_KEY = "steam:profile:v3"
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
        return c.json({ error: true, status: response.status })
    }

    const data = await response.json() as any;
    const games: any[] | undefined = data.response?.games;

    if (!games || games.length === 0) {
        return c.json({ error: true, message: 'No games found or Steam API key not configured' }, 500 as any)
    }

    const totalPlaytime = games.reduce((total: number, game: any) => total + (game.playtime_forever || 0), 0);
    const totalHours = Math.round(totalPlaytime / 60);

    const lastPlayedGame = games.reduce((latest: any, game: any) => {
        if (!latest || ((game.rtime_last_played || 0) > (latest.rtime_last_played || 0))) {
            return game;
        }
        return latest;
    }, null);

    const sorted = games.sort((a: any, b: any) => (b.playtime_forever || 0) - (a.playtime_forever || 0));

    const topGames = sorted
        .slice(0, 3)
        .map((game: any) => ({ name: game.name, hours: Math.round((game.playtime_forever || 0) / 60) }));

    const result: SteamResult = {
        totalHours,
        totalPlaytime,
        gameCount: games.length,
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

    const cachedRes = await c.env.KV.get(CACHE_KEY, { type: "json" })
    if (cachedRes) {
        return c.json(cachedRes)
    }

    const STEAM_API_KEY = c.env.STEAM_API_KEY
    const STEAM_ID = '76561198045384584';
    const apiUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${STEAM_ID}`;

    const response = await fetch(apiUrl);
    if (!response.ok) {
        return c.json({ error: true, status: response.status })
    }

    const data = await response.json() as any;
    const player = data.response.players[0];

    const result = { avatarUrl: player.avatarfull }
    await c.env.KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_DURATION })
    return c.json(result)
})

app.get('/my-steam-level', async (c) => {
    const CACHE_KEY = "steam:level"
    const CACHE_DURATION = 3600;

    const cachedRes = await c.env.KV.get(CACHE_KEY, { type: "json" })
    if (cachedRes) {
        return c.json(cachedRes)
    }

    const STEAM_API_KEY = c.env.STEAM_API_KEY
    const STEAM_ID = '76561198045384584';
    const apiUrl = `https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/?key=${STEAM_API_KEY}&steamid=${STEAM_ID}`;

    const response = await fetch(apiUrl);
    if (!response.ok) {
        return c.json({ error: true, status: response.status })
    }

    const data = await response.json() as any;
    const result = { steamLevel: data.response.player_level };
    await c.env.KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_DURATION })
    return c.json(result)
})

export default app
