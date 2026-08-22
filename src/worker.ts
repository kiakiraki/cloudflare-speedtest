interface Env {
  ASSETS: Fetcher;
  TURN_KEY_ID?: string;
  TURN_TOKEN?: string;
}

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(key) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  );
  if (hits.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(key, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) {
      if (v.every((t) => now - t >= RATE_LIMIT_WINDOW_MS))
        rateBuckets.delete(k);
    }
  }
  return false;
}

function browserSafeUrls(urls: string[]): string[] {
  return urls.filter((u) => !u.split('?')[0].endsWith(':53'));
}

function normalizeIceServers(data: unknown): IceServerConfig[] {
  const raw =
    data && typeof data === 'object' && 'iceServers' in data
      ? (data as { iceServers?: unknown }).iceServers
      : data;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object'
      ? [raw]
      : [];
  const servers: IceServerConfig[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as {
      urls?: unknown;
      username?: unknown;
      credential?: unknown;
    };
    const rawUrls = Array.isArray(entry.urls)
      ? entry.urls
      : typeof entry.urls === 'string'
        ? [entry.urls]
        : [];
    const urls = browserSafeUrls(
      rawUrls.filter((u): u is string => typeof u === 'string'),
    );
    if (!urls.length) continue;
    const server: IceServerConfig = { urls };
    if (typeof entry.username === 'string') server.username = entry.username;
    if (typeof entry.credential === 'string')
      server.credential = entry.credential;
    servers.push(server);
  }
  return servers;
}

async function handleTurnCredentials(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }
  const origin = req.headers.get('Origin');
  if (origin && origin !== new URL(req.url).origin) {
    return Response.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (rateLimited(ip)) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }
  if (!env.TURN_KEY_ID || !env.TURN_TOKEN) {
    return Response.json({ error: 'turn_not_configured' }, { status: 503 });
  }
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 3600 }),
      },
    );
    if (!res.ok)
      return Response.json({ error: 'turn_api_error' }, { status: 502 });
    const servers = normalizeIceServers(await res.json());
    if (!servers.length)
      return Response.json({ error: 'no_ice_server' }, { status: 502 });
    return Response.json(servers, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'turn_api_error' }, { status: 502 });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/turn-credentials') {
      return handleTurnCredentials(req, env);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
