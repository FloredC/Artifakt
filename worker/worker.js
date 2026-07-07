/**
 * Artifakt fal.ai proxy + rate limiter.
 *
 * Route: POST /proxy/<fal model path>, e.g.
 *   POST /proxy/fal-ai/flux/schnell
 *   POST /proxy/fal-ai/flux/dev/image-to-image
 *
 * The browser never sees the fal.ai key — it's injected here from env.
 *
 * Env bindings (see wrangler.toml):
 *   RATE_LIMIT_KV — KV namespace for counters
 *   FAL_API_KEY   — fal.ai API key, set via `wrangler secret put FAL_API_KEY`
 */

// Each full "generation" the user sees on screen costs 3 calls through this
// proxy (1 scaffold + 2 image-to-image passes), so these are call counts,
// not generation counts — scale accordingly if you tune them.
const PER_IP_DAILY_LIMIT = 9;   // ≈ 3 generations per visitor per day
const GLOBAL_DAILY_LIMIT = 300; // ≈ 100 generations per day, site-wide budget backstop

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function getCounter(kv, key) {
  return parseInt((await kv.get(key)) || '0', 10);
}

// KV has no atomic increment — this is a plain read-then-write. On free-tier
// traffic that's an acceptable simplification (two concurrent requests could
// under-count by one); move to Durable Objects if that ever matters.
async function incrementCounter(kv, key, ttlSeconds) {
  const current = await getCounter(kv, key);
  await kv.put(key, String(current + 1), { expirationTtl: ttlSeconds });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/proxy\/(.+)$/);
    if (request.method !== 'POST' || !match) {
      return json(404, { error: 'not_found' });
    }
    const modelPath = match[1];

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const ipKey = `ip:${ip}`;
    const globalKey = `global:${todayUTC()}`;

    const [ipCount, globalCount] = await Promise.all([
      getCounter(env.RATE_LIMIT_KV, ipKey),
      getCounter(env.RATE_LIMIT_KV, globalKey),
    ]);

    // Global cap is the real budget backstop — it wins even if this visitor
    // still has quota left.
    if (globalCount >= GLOBAL_DAILY_LIMIT) {
      return json(429, { reason: 'global_limit' });
    }
    if (ipCount >= PER_IP_DAILY_LIMIT) {
      return json(429, { reason: 'per_user_limit' });
    }

    await Promise.all([
      incrementCounter(env.RATE_LIMIT_KV, ipKey, 60 * 60 * 24),
      incrementCounter(env.RATE_LIMIT_KV, globalKey, 60 * 60 * 24 * 2),
    ]);

    const body = await request.text();
    const falRes = await fetch(`https://fal.run/${modelPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${env.FAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    const responseBody = await falRes.text();
    return new Response(responseBody, {
      status: falRes.status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  },
};
