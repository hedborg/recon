// ---------------------------------------------------------------------------
// FX rate resolution — SEK per 1 unit of coin
//
// Lookup order:
//   1. In-process memory cache
//   2. fx_rates table in Postgres
//   3. External API — fetched in bulk per coin (not per date)
//        Stablecoins  → Frankfurter timeseries  (one call covers all dates)
//        Crypto       → CoinGecko market_chart/range (one call per coin)
// ---------------------------------------------------------------------------

const pool = require('./db');

const USD_STABLECOINS = new Set(['USDT','USDC','BUSD','DAI','TUSD','FDUSD','USDP','UST']);

// Fiat currencies handled by Frankfurter (base currency → SEK)
// Add more as new exchanges bring new fiats
const FIAT_CURRENCIES = new Map([
  ['EUR', 'EUR'],
  ['USD', 'USD'],
  ['GBP', 'GBP'],
  ['CHF', 'CHF'],
  ['NOK', 'NOK'],
  ['DKK', 'DKK'],
]);

const CG_IDS = {
  BTC:   'bitcoin',       ETH:   'ethereum',      BNB:   'binancecoin',
  SOL:   'solana',        ADA:   'cardano',        XRP:   'ripple',
  DOT:   'polkadot',      MATIC: 'matic-network',  LINK:  'chainlink',
  LTC:   'litecoin',      BCH:   'bitcoin-cash',   AVAX:  'avalanche-2',
  ATOM:  'cosmos',        UNI:   'uniswap',        DOGE:  'dogecoin',
  TRX:   'tron',          ETC:   'ethereum-classic', XLM:  'stellar',
  FIL:   'filecoin',      VET:   'vechain',          TON:  'the-open-network',
  LNX:   'bitcoin',      // Bitfinex Lightning Network BTC — 1:1 with BTC
  DASH:  'dash',
};

// Memory cache: "COIN:YYYY-MM-DD" → rate (only positive values stored)
const memCache = {};

// Refresh job state
const refreshState = { running: false, total: 0, done: 0, saved: 0, errors: 0, startedAt: null };

// ── Public API ──────────────────────────────────────────────────────────────

async function getRateSek(coin, dateStr) {
  const key = `${coin.toUpperCase()}:${dateStr}`;
  if (memCache[key]) return memCache[key];

  const dbRate = await loadFromDb(coin.toUpperCase(), dateStr);
  if (dbRate !== null) { memCache[key] = dbRate; return dbRate; }

  // Single-date fallback (used by proposal bar, not bulk refresh)
  const rate = await fetchSingle(coin.toUpperCase(), dateStr);
  if (rate !== null) {
    memCache[key] = rate;
    await saveToDb(coin.toUpperCase(), dateStr, rate,
      USD_STABLECOINS.has(coin.toUpperCase()) ? 'frankfurter' : 'coingecko');
  }
  return rate;
}

async function getRatesBatch(pairs) {
  const result = {};
  await Promise.all(pairs.map(async ({ coin, date }) => {
    const rate = await getRateSek(coin, date);
    if (rate != null) result[`${coin.toUpperCase()}:${date}`] = rate;
  }));
  return result;
}

// ---------------------------------------------------------------------------
// Refresh: group missing dates by coin, fetch each coin in ONE range call
// ---------------------------------------------------------------------------
async function startRefresh() {
  if (refreshState.running) return refreshState;

  const { rows: missing } = await pool.query(`
    SELECT DISTINCT s.currency AS coin, DATE(s.date)::text AS rate_date
    FROM stg_statements s
    WHERE NOT EXISTS (
      SELECT 1 FROM fx_rates f WHERE f.coin = s.currency AND f.rate_date = DATE(s.date)
    )
    ORDER BY coin, rate_date
  `);

  if (missing.length === 0) {
    return { ...refreshState, total: 0, done: 0, saved: 0 };
  }

  // Group by coin
  const byCoin = {};
  for (const { coin, rate_date } of missing) {
    (byCoin[coin] = byCoin[coin] || []).push(rate_date);
  }

  refreshState.running   = true;
  refreshState.total     = missing.length;
  refreshState.done      = 0;
  refreshState.saved     = 0;
  refreshState.errors    = 0;
  refreshState.startedAt = new Date().toISOString();

  // Run in background
  (async () => {
    for (const [coin, dates] of Object.entries(byCoin)) {
      try {
        const rateMap = await fetchRangeForCoin(coin.toUpperCase(), dates);
        for (const date of dates) {
          const rate = rateMap[date];
          if (rate != null) {
            memCache[`${coin.toUpperCase()}:${date}`] = rate;
            await saveToDb(coin.toUpperCase(), date, rate,
              USD_STABLECOINS.has(coin.toUpperCase()) ? 'frankfurter' : 'coingecko');
            refreshState.saved++;
          } else {
            refreshState.errors++;
          }
          refreshState.done++;
        }
      } catch (e) {
        console.error(`Refresh error for ${coin}: ${e.message}`);
        refreshState.errors += dates.length;
        refreshState.done   += dates.length;
      }
    }
    refreshState.running = false;
    console.log(`FX refresh done: ${refreshState.saved} saved, ${refreshState.errors} missing`);
  })();

  return refreshState;
}

// ── Bulk range fetchers ─────────────────────────────────────────────────────

async function fetchRangeForCoin(coin, dates) {
  // USD stablecoins → Frankfurter (USD base)
  if (USD_STABLECOINS.has(coin)) return fetchFrankfurterRange('USD', dates);
  // Fiat currencies → Frankfurter (native base)
  if (FIAT_CURRENCIES.has(coin)) return fetchFrankfurterRange(coin, dates);
  // Crypto → CoinGecko
  const cgId = CG_IDS[coin];
  if (!cgId) { console.warn(`No CoinGecko ID for ${coin} — skipping`); return {}; }
  return fetchCoinGeckoRange(cgId, coin, dates);
}

// Frankfurter timeseries: one call covers the full date range
// baseCurrency: 'USD' for stablecoins, 'EUR' for Kraken EUR rows, etc.
async function fetchFrankfurterRange(baseCurrency, dates) {
  const sorted = [...dates].sort();
  const from   = sorted[0];
  const to     = sorted[sorted.length - 1];
  try {
    const url = from === to
      ? `https://api.frankfurter.app/${from}?from=${baseCurrency}&to=SEK`
      : `https://api.frankfurter.app/${from}..${to}?from=${baseCurrency}&to=SEK`;
    const r = await fetchWithTimeout(url, 10000);
    if (!r.ok) { console.warn(`Frankfurter ${r.status} for ${baseCurrency}`); return {}; }
    const j = await r.json();

    const raw = {};
    // Timeseries response: j.rates = { "2026-01-03": { SEK: 11.23 }, ... }
    for (const [date, rates] of Object.entries(j.rates || {})) {
      if (rates.SEK) raw[date] = rates.SEK;
    }
    // Single-date response: j.rates = { SEK: 11.23 }, j.date = "2026-01-03"
    if (j.date && j.rates?.SEK) raw[j.date] = j.rates.SEK;

    // Forward-fill weekends / holidays
    const result = {};
    let last = null;
    for (const d of expandDateRange(from, to)) {
      if (raw[d]) last = raw[d];
      result[d] = last;
    }
    console.log(`FX Frankfurter ${baseCurrency}/SEK ${from}..${to}: ${Object.keys(raw).length} trading days`);
    return result;
  } catch (e) {
    console.warn(`Frankfurter range error (${baseCurrency}): ${e.message}`);
    return {};
  }
}

// CoinGecko market_chart/range: one call per coin, returns all daily prices
async function fetchCoinGeckoRange(cgId, coin, dates) {
  const sorted   = [...dates].sort();
  const fromDate = sorted[0];
  const toDate   = sorted[sorted.length - 1];

  // Add 1-day buffer each side
  const fromTs = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000) - 86400;
  const toTs   = Math.floor(new Date(toDate   + 'T23:59:59Z').getTime() / 1000) + 86400;

  try {
    console.log(`FX CoinGecko range ${coin} ${fromDate}..${toDate}`);
    // Add a small delay to be polite to the free tier
    await new Promise(res => setTimeout(res, 1500));
    const r = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/coins/${cgId}/market_chart/range?vs_currency=sek&from=${fromTs}&to=${toTs}`,
      15000
    );
    if (r.status === 429) {
      console.warn(`CoinGecko rate-limited for ${coin} — click Refresh FX again shortly`);
      return {};
    }
    if (!r.ok) { console.warn(`CoinGecko ${r.status} for ${coin}`); return {}; }

    const j = await r.json();
    // prices: [[timestamp_ms, price], ...]
    // Build a date→price map; for multiple prices per day, take the last one
    const byDate = {};
    for (const [ts, price] of (j.prices || [])) {
      const d = new Date(ts).toISOString().slice(0, 10);
      byDate[d] = price;  // later entries overwrite earlier (want end-of-day)
    }

    // Map requested dates to nearest available price (forward-fill gaps)
    const result  = {};
    let   lastVal = null;
    const allDates = expandDateRange(fromDate, toDate);
    for (const d of allDates) {
      if (byDate[d] != null) lastVal = byDate[d];
      result[d] = lastVal;
    }
    console.log(`FX CoinGecko ${coin}: ${Object.keys(byDate).length} price points for ${dates.length} requested dates`);
    return result;
  } catch (e) {
    console.warn(`CoinGecko range error ${coin}: ${e.message}`);
    return {};
  }
}

// ── Single-date fallback (for proposal bar FX lookups) ─────────────────────

async function fetchSingle(coin, dateStr) {
  if (USD_STABLECOINS.has(coin)) {
    const map = await fetchFrankfurterRange('USD', [dateStr]);
    return map[dateStr] ?? null;
  }
  if (FIAT_CURRENCIES.has(coin)) {
    const map = await fetchFrankfurterRange(coin, [dateStr]);
    return map[dateStr] ?? null;
  }
  const cgId = CG_IDS[coin];
  if (!cgId) return null;
  const map = await fetchCoinGeckoRange(cgId, coin, [dateStr]);
  return map[dateStr] ?? null;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

async function loadFromDb(coin, dateStr) {
  try {
    const { rows } = await pool.query(
      `SELECT rate_sek FROM fx_rates WHERE coin = $1 AND rate_date = $2::date`,
      [coin, dateStr]
    );
    return rows.length ? parseFloat(rows[0].rate_sek) : null;
  } catch (e) { return null; }
}

async function saveToDb(coin, dateStr, rate, source) {
  try {
    await pool.query(`
      INSERT INTO fx_rates (coin, rate_date, rate_sek, source)
      VALUES ($1, $2::date, $3, $4)
      ON CONFLICT (coin, rate_date) DO UPDATE SET rate_sek = EXCLUDED.rate_sek, fetched_at = NOW()
    `, [coin, dateStr, rate, source]);
  } catch (e) { console.warn(`DB FX save error: ${e.message}`); }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Returns every calendar date between from and to inclusive
function expandDateRange(from, to) {
  const dates = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

module.exports = { getRateSek, getRatesBatch, startRefresh, refreshState, USD_STABLECOINS, FIAT_CURRENCIES };
