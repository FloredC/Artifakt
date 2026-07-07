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
 *   NTFY_TOPIC    — ntfy.sh topic for the global-limit push alert, set via
 *                   `wrangler secret put NTFY_TOPIC` (kept out of source since
 *                   ntfy topics are public/guessable — anyone with the name
 *                   can read or post to it)
 */

// A single full visit (type a keyword, see all 5 artists) costs 11 calls
// through this proxy: 1 scaffold + 5 artists × 2 image-to-image passes each
// (buildScreen2 pre-generates all 5 artists in parallel, not just the one
// the visitor clicks on). These are call counts, not visit counts — scale
// accordingly if you tune them.
const PER_IP_DAILY_LIMIT = 24;  // ≈ 2 full visits per visitor per day (22) + a little slack
const GLOBAL_DAILY_LIMIT = 825; // ≈ 75 full visits per day (~$24.75 max fal.ai spend/day), site-wide budget backstop

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

// Pings Flore's phone the first time the global cap trips each day. The KV
// flag makes this a one-shot: every request after the first blocked one that
// day sees `alreadyNotified` and skips the ntfy call.
async function notifyGlobalLimitOnce(env) {
  const notifiedKey = `notified:${todayUTC()}`;
  const alreadyNotified = await env.RATE_LIMIT_KV.get(notifiedKey);
  if (alreadyNotified) return;
  await env.RATE_LIMIT_KV.put(notifiedKey, '1', { expirationTtl: 60 * 60 * 24 * 2 });

  if (!env.NTFY_TOPIC) return; // secret not set yet — skip silently
  await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: 'Artifakt: global rate limit tripped', Priority: 'default' },
    body: `Global daily limit (${GLOBAL_DAILY_LIMIT} calls) reached. Visitors are now getting the "taking a breather" overlay for the rest of today (UTC).`,
  });
}

export default {
  async fetch(request, env, ctx) {
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
      // Don't make the visitor wait on the ntfy push — fire and let the
      // Worker keep it alive after the response is sent.
      ctx.waitUntil(notifyGlobalLimitOnce(env));
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
