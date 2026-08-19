// XMR/USD from Kraken's public ticker (keyless; CoinGecko 403s requests from
// workers). Stored as integer micro-USD per XMR. Each fetch goes through the
// Workers Cache API with a TTL, falling back to the last-known-good row in
// D1's rate_cache. Display only: prices on listings are piconero, and the
// marketplace never moves money.

const XMR_USD = {
  key: 'xmr_usd',
  url: 'https://api.kraken.com/0/public/Ticker?pair=XMRUSD',
  ttlSeconds: 60,
  // c[0] is the last trade price.
  extract: (json: unknown) =>
    Number((json as { result: { XXMRZUSD: { c: [string] } } }).result.XXMRZUSD.c[0]),
};

export async function usdPerXmrMicro(db: D1Database): Promise<number> {
  const spec = XMR_USD;
  const cacheKey = new Request(`https://gpubnb-rate-cache.internal/${spec.key}`);
  // The tsconfig carries both DOM and workers-types libs (one config for SPA +
  // worker), and the DOM's CacheStorage hides the workers-only `default`.
  const cache = (caches as unknown as { default: Cache }).default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const { value } = (await cached.json()) as { value: number };
    return value;
  }

  let micro: number | null = null;
  try {
    const res = await fetch(spec.url, {
      headers: { accept: 'application/json', 'user-agent': 'gpubnb/1.0 (+attested inference directory)' },
    });
    if (res.ok) {
      const usd = spec.extract(await res.json());
      if (usd > 0) micro = Math.round(usd * 1_000_000);
    } else {
      console.error(`rate fetch ${spec.key}: upstream ${res.status}`);
    }
  } catch (err) {
    console.error(`rate fetch ${spec.key}:`, err);
    // fall through to last-known-good
  }

  if (micro !== null) {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify({ value: micro }), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `max-age=${spec.ttlSeconds}`,
        },
      })
    );
    await db
      .prepare(
        'INSERT INTO rate_cache (key, value, fetched_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at'
      )
      .bind(spec.key, micro, Date.now())
      .run();
    return micro;
  }

  const row = await db
    .prepare('SELECT value FROM rate_cache WHERE key = ?')
    .bind(spec.key)
    .first<{ value: number }>();
  if (!row) throw new Error(`rate unavailable: ${spec.key}`);
  return row.value;
}
