// Rate sources, both keyless: frankfurter.dev (ECB) for CAD→USD at expense
// entry, Kraken's public ticker for XMR/USD at payment view (CoinGecko 403s
// requests from workers). Values are stored as integer micro-USD per source
// unit. Each fetch goes through the Workers Cache API with a TTL, falling
// back to the last-known-good row in D1's rate_cache.

interface RateSpec {
  key: 'cad_usd' | 'xmr_usd';
  url: string;
  ttlSeconds: number;
  extract: (json: unknown) => number; // → USD per unit (float)
}

const CAD_USD: RateSpec = {
  key: 'cad_usd',
  url: 'https://api.frankfurter.dev/v1/latest?base=CAD&symbols=USD',
  ttlSeconds: 3600,
  extract: (json) => (json as { rates: { USD: number } }).rates.USD,
};

const XMR_USD: RateSpec = {
  key: 'xmr_usd',
  url: 'https://api.kraken.com/0/public/Ticker?pair=XMRUSD',
  ttlSeconds: 60,
  // c[0] is the last trade price.
  extract: (json) =>
    Number((json as { result: { XXMRZUSD: { c: [string] } } }).result.XXMRZUSD.c[0]),
};

async function microUsdRate(db: D1Database, spec: RateSpec): Promise<number> {
  const cacheKey = new Request(`https://tabby-rate-cache.internal/${spec.key}`);
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
      headers: { accept: 'application/json', 'user-agent': 'tabby/1.0 (+group expense app)' },
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

// USD per CAD as a float (feeds money.tabMicroPerUnit).
export async function usdPerCad(db: D1Database): Promise<number> {
  return (await microUsdRate(db, CAD_USD)) / 1_000_000;
}

// µTAB per XMR (integer): micro-USD per XMR ÷ 100, since 1 USD = 10,000 µTAB.
export async function xmrRateTabMicro(db: D1Database): Promise<number> {
  return Math.round((await microUsdRate(db, XMR_USD)) / 100);
}
