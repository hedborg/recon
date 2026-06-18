const express = require('express');
const pool    = require('../db');
const { getRateSek, getRatesBatch, startRefresh, refreshState } = require('../fx');
const router  = express.Router();

// ---------------------------------------------------------------------------
// GET /api/unmatched/fortnox?from=&to=&account=1971&show=all
// show=all → include matched rows (with is_matched flag); default = unmatched only
// ---------------------------------------------------------------------------
router.get('/unmatched/fortnox', async (req, res) => {
  const { from, to, account = '1971', show } = req.query;
  const showAll = show === 'all';
  try {
    const { rows } = await pool.query(`
      SELECT f.id, f.vernr, f.bokforingsdatum, f.konto,
             f.verifikationstext, f.transaktionsinfo,
             f.debet, f.kredit, f.project_currency,
             (m.fortnox_id IS NOT NULL) AS is_matched
      FROM stg_fortnox f
      LEFT JOIN (SELECT DISTINCT fortnox_id FROM recon_matches) m ON m.fortnox_id = f.id
      WHERE f.konto = $1
        AND ($2::date IS NULL OR f.bokforingsdatum >= $2::date)
        AND ($3::date IS NULL OR f.bokforingsdatum <= $3::date)
        AND ($4 OR m.fortnox_id IS NULL)
      ORDER BY f.bokforingsdatum DESC, f.vernr
    `, [account, from || null, to || null, showAll]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/unmatched/statements?from=&to=&account=1971&show=all
// ---------------------------------------------------------------------------
router.get('/unmatched/statements', async (req, res) => {
  const { from, to, account = '1971', show } = req.query;
  const showAll = show === 'all';
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.date, s.source, s.account, s.type, s.subtype,
             s.currency, s.amount, s.fee, s.transaction_id, s.remark,
             s.contra_account, s.voucher_text,
             (m.statement_id IS NOT NULL) AS is_matched
      FROM stg_statements s
      LEFT JOIN (SELECT DISTINCT statement_id FROM recon_matches) m ON m.statement_id = s.id
      WHERE s.account = $1
        AND ($2::date IS NULL OR DATE(s.date) >= $2::date)
        AND ($3::date IS NULL OR DATE(s.date) <= $3::date)
        AND ($4 OR m.statement_id IS NULL)
      ORDER BY s.date DESC
    `, [account, from || null, to || null, showAll]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/matches/by-fortnox/:id  — all match records for one Fortnox row
// ---------------------------------------------------------------------------
router.get('/matches/by-fortnox/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.match_type, m.fx_rate_used, m.notes, m.matched_by, m.matched_at,
             s.id AS statement_id, s.date AS s_date, s.source, s.type AS s_type,
             s.subtype, s.currency, s.amount AS s_amount, s.fee,
             s.transaction_id, s.remark
      FROM recon_matches m
      LEFT JOIN stg_statements s ON s.id = m.statement_id
      WHERE m.fortnox_id = $1
      ORDER BY m.matched_at
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// GET /api/statements/operations?account=1971
// ---------------------------------------------------------------------------
router.get('/statements/operations', async (req, res) => {
  const { account = '1971' } = req.query;
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT type AS operation
      FROM stg_statements
      WHERE account = $1 AND type IS NOT NULL
      ORDER BY type
    `, [account]);
    res.json(rows.map(r => r.operation));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/statements/currencies?account=1971
// ---------------------------------------------------------------------------
router.get('/statements/currencies', async (req, res) => {
  const { account = '1971' } = req.query;
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT currency
      FROM stg_statements
      WHERE account = $1 AND currency IS NOT NULL
      ORDER BY currency
    `, [account]);
    res.json(rows.map(r => r.currency));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/chart-of-accounts
// ---------------------------------------------------------------------------
router.get('/chart-of-accounts', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT account_number, account_name FROM chart_of_accounts ORDER BY account_number`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// POST /api/chart-of-accounts  — add a new account
// ---------------------------------------------------------------------------
router.post('/chart-of-accounts', async (req, res) => {
  const { account_number, account_name } = req.body;
  if (!account_number || !account_name) return res.status(400).json({ error: 'account_number and account_name required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO chart_of_accounts (account_number, account_name) VALUES ($1, $2)
       ON CONFLICT (account_number) DO UPDATE SET account_name = EXCLUDED.account_name
       RETURNING *`,
      [account_number, account_name]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// PATCH /api/statements/:id  — update contra_account / voucher_text
// ---------------------------------------------------------------------------
router.patch('/statements/:id', async (req, res) => {
  const { contra_account, voucher_text } = req.body;
  const updates = [], values = [];
  let i = 1;
  if ('contra_account' in req.body) { updates.push(`contra_account = $${i++}`); values.push(contra_account || null); }
  if ('voucher_text'   in req.body) { updates.push(`voucher_text   = $${i++}`); values.push(voucher_text   || null); }
  if (!updates.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE stg_statements SET ${updates.join(', ')} WHERE id = $${i}`, values);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// GET /api/accounts  — distinct accounts in stg_statements
// ---------------------------------------------------------------------------
router.get('/accounts', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT account, source
      FROM stg_statements
      ORDER BY account
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// FX rate endpoints (unchanged)
// ---------------------------------------------------------------------------
router.post('/fx-rates/refresh', async (_req, res) => {
  try { res.json(await startRefresh()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/fx-rates/status', (_req, res) => res.json(refreshState));

router.get('/fx-rates/table', async (req, res) => {
  const { coin, from, to } = req.query;
  try {
    const { rows } = await pool.query(`
      SELECT coin, rate_date, rate_sek, source, fetched_at
      FROM fx_rates
      WHERE ($1::text IS NULL OR coin = $1)
        AND ($2::date IS NULL OR rate_date >= $2::date)
        AND ($3::date IS NULL OR rate_date <= $3::date)
      ORDER BY coin, rate_date
    `, [coin || null, from || null, to || null]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message }); }
});

router.get('/fx-rates/coverage', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.currency                                               AS coin,
        COUNT(DISTINCT DATE(s.date))                            AS needed,
        COUNT(DISTINCT f.rate_date)                             AS have,
        MIN(DATE(s.date))::text                                 AS first_needed,
        MAX(DATE(s.date))::text                                 AS last_needed
      FROM stg_statements s
      LEFT JOIN fx_rates f ON f.coin = s.currency AND f.rate_date = DATE(s.date)
      GROUP BY s.currency
      ORDER BY s.currency
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message }); }
});

router.get('/fx-rate', async (req, res) => {
  const { date, coin = 'USDT' } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    const rate = await getRateSek(coin.toUpperCase(), date);
    if (rate == null) return res.status(502).json({ error: `No rate for ${coin} on ${date}` });
    res.json({ date, coin, rate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/fx-rates', async (req, res) => {
  const pairs = (req.query.pairs || '').split(',').map(p => {
    const [coin, date] = p.trim().split(':');
    return coin && date ? { coin: coin.toUpperCase(), date } : null;
  }).filter(Boolean);
  if (!pairs.length) return res.json({});
  try { res.json(await getRatesBatch(pairs)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// POST /api/automatch  — bulk auto-match for an account
//
// Priority 1: exact text match (verifikationstext/transaktionsinfo vs remark/transaction_id)
//             → match if exactly 1 unmatched statement row matches
// Priority 2: amount ±10% SEK + date ±2 days
//             → match if exactly 1 unmatched statement row qualifies
// Skips any Fortnox row where the result is ambiguous (0 or 2+)
// ---------------------------------------------------------------------------
router.post('/automatch', async (req, res) => {
  const { account = '1971', from, to, op } = req.body;
  const client = await pool.connect();
  let exactMatched = 0, rangeMatched = 0, skipped = 0;

  try {
    // Load unmatched Fortnox kredit rows — respect date filter if supplied
    const { rows: fnRows } = await pool.query(`
      SELECT f.id, f.bokforingsdatum, f.kredit, f.vernr,
             f.verifikationstext, f.transaktionsinfo
      FROM stg_fortnox f
      WHERE f.konto = $1
        AND f.kredit > 0
        AND NOT EXISTS (SELECT 1 FROM recon_matches m WHERE m.fortnox_id = f.id)
        AND ($2::date IS NULL OR f.bokforingsdatum >= $2::date)
        AND ($3::date IS NULL OR f.bokforingsdatum <= $3::date)
      ORDER BY f.bokforingsdatum
    `, [account, from || null, to || null]);

    // Load unmatched statement rows — respect date + operation filter if supplied
    const { rows: stRows } = await pool.query(`
      SELECT s.id, s.date, s.currency, s.amount, s.remark, s.transaction_id
      FROM stg_statements s
      WHERE s.account = $1
        AND NOT EXISTS (SELECT 1 FROM recon_matches m WHERE m.statement_id = s.id)
        AND ($2::date IS NULL OR DATE(s.date) >= $2::date)
        AND ($3::date IS NULL OR DATE(s.date) <= $3::date)
        AND ($4::text IS NULL OR s.type ILIKE $4::text)
    `, [account, from || null, to || null, op ? `%${op}%` : null]);

    // Track rows consumed in this run so we don't double-match
    const usedStIds = new Set();

    await client.query('BEGIN');

    for (const fn of fnRows) {
      const fnSek  = parseFloat(fn.kredit) * -1;  // kredit is positive in Fortnox; negate to match negative statement withdrawals
      const fnDate = toDateStr(fn.bokforingsdatum);
      if (!fnDate) { skipped++; continue; }  // skip rows with no booking date

      // ── Priority 1: exact text match ────────────────────────────────────
      const fnTexts = [fn.verifikationstext, fn.transaktionsinfo]
        .filter(Boolean).map(s => s.trim().toLowerCase());

      if (fnTexts.length) {
        const exact = stRows.filter(s => {
          if (usedStIds.has(s.id)) return false;
          return [s.remark, s.transaction_id]
            .filter(Boolean)
            .map(t => t.trim().toLowerCase())
            .some(t => fnTexts.includes(t));
        });

        if (exact.length === 1) {
          const st      = exact[0];
          const dateStr = toDateStr(st.date);
          const fxRate  = await getRateSek(st.currency, dateStr);
          await client.query(`
            INSERT INTO recon_matches
              (fortnox_id, statement_id, match_type, fx_rate_used, notes, matched_by)
            VALUES ($1,$2,'auto',$3,$4,'automatch')
          `, [fn.id, st.id,
              fxRate ? fxRate.toFixed(6) : null,
              `Exact text match: "${fnTexts[0]}"`]);
          usedStIds.add(st.id);
          exactMatched++;
          continue;
        }
        // 2+ exact matches = ambiguous, fall through to range
      }

      // ── Priority 2: amount ±10% SEK, date ±2 days ───────────────────────
      const dateMin = addDaysStr(fnDate, -2);
      const dateMax = addDaysStr(fnDate,  2);
      if (!dateMin || !dateMax) { skipped++; continue; }
      const sekMin  = fnSek * 1.10;  // fnSek is negative, so min is more negative
      const sekMax  = fnSek * 0.90;

      // Candidates in date window (cheap pre-filter, no FX needed yet)
      const candidates = stRows.filter(s => {
        if (usedStIds.has(s.id)) return false;
        const d = toDateStr(s.date);
        return d && d >= dateMin && d <= dateMax;
      });

      // Apply FX conversion and SEK range filter
      const inRange = [];
      for (const st of candidates) {
        const dateStr = toDateStr(st.date);
        if (!dateStr) continue;
        const fxRate  = await getRateSek(st.currency, dateStr);
        if (!fxRate) continue;
        const stSek = parseFloat(st.amount) * fxRate;
        if (stSek >= sekMin && stSek <= sekMax) {
          inRange.push({ ...st, _fxRate: fxRate, _stSek: stSek });
        }
      }

      if (inRange.length === 1) {
        const st   = inRange[0];
        const diff = Math.abs(fnSek - st._stSek) / Math.abs(fnSek) * 100;
        await client.query(`
          INSERT INTO recon_matches
            (fortnox_id, statement_id, match_type, fx_rate_used, notes, matched_by)
          VALUES ($1,$2,'auto',$3,$4,'automatch')
        `, [fn.id, st.id,
            st._fxRate.toFixed(6),
            `Auto range: ${parseFloat(st.amount).toFixed(4)} ${st.currency} × ${st._fxRate.toFixed(4)} = ${st._stSek.toFixed(2)} SEK vs ${fnSek.toFixed(2)} SEK (${diff.toFixed(2)}%)`]);
        usedStIds.add(st.id);
        rangeMatched++;
      } else {
        skipped++;
      }
    }

    await client.query('COMMIT');
    res.json({
      matched: exactMatched + rangeMatched,
      exact:   exactMatched,
      range:   rangeMatched,
      skipped,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Automatch error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /api/automatch/tight — exact date + ≤5% SEK difference
// ---------------------------------------------------------------------------
router.post('/automatch/tight', async (req, res) => {
  const { account = '1971', from, to } = req.body;
  const client = await pool.connect();
  let matched = 0, skipped = 0;

  try {
    const { rows: fnRows } = await pool.query(`
      SELECT f.id, f.bokforingsdatum, f.kredit, f.vernr,
             f.verifikationstext, f.transaktionsinfo
      FROM stg_fortnox f
      WHERE f.konto = $1
        AND f.kredit > 0
        AND NOT EXISTS (SELECT 1 FROM recon_matches m WHERE m.fortnox_id = f.id)
        AND ($2::date IS NULL OR f.bokforingsdatum >= $2::date)
        AND ($3::date IS NULL OR f.bokforingsdatum <= $3::date)
      ORDER BY f.bokforingsdatum
    `, [account, from || null, to || null]);

    const { rows: stRows } = await pool.query(`
      SELECT s.id, s.date, s.currency, s.amount, s.remark, s.transaction_id
      FROM stg_statements s
      WHERE s.account = $1
        AND NOT EXISTS (SELECT 1 FROM recon_matches m WHERE m.statement_id = s.id)
        AND ($2::date IS NULL OR DATE(s.date) >= $2::date)
        AND ($3::date IS NULL OR DATE(s.date) <= $3::date)
    `, [account, from || null, to || null]);

    const usedStIds = new Set();
    await client.query('BEGIN');

    for (const fn of fnRows) {
      const fnSek  = parseFloat(fn.kredit) * -1;  // negate to match negative statement withdrawals
      const fnDate = toDateStr(fn.bokforingsdatum);
      if (!fnDate) { skipped++; continue; }

      const sekMin  = fnSek * 1.05;  // fnSek is negative, so min is more negative
      const sekMax  = fnSek * 0.95;
      const dateMin = addDaysStr(fnDate, -1);
      const dateMax = addDaysStr(fnDate,  1);

      // Candidates within ±1 day
      const candidates = stRows.filter(s => {
        if (usedStIds.has(s.id)) return false;
        const d = toDateStr(s.date);
        return d && d >= dateMin && d <= dateMax;
      });

      const inRange = [];
      for (const st of candidates) {
        const fxRate = await getRateSek(st.currency, fnDate);
        if (!fxRate) continue;
        const stSek = parseFloat(st.amount) * fxRate;
        if (stSek >= sekMin && stSek <= sekMax) {
          inRange.push({ ...st, _fxRate: fxRate, _stSek: stSek });
        }
      }

      if (inRange.length === 1) {
        const st   = inRange[0];
        const diff = Math.abs(fnSek - st._stSek) / Math.abs(fnSek) * 100;
        await client.query(`
          INSERT INTO recon_matches
            (fortnox_id, statement_id, match_type, fx_rate_used, notes, matched_by)
          VALUES ($1,$2,'auto',$3,$4,'automatch-tight')
        `, [fn.id, st.id,
            st._fxRate.toFixed(6),
            `Tight: ${parseFloat(st.amount).toFixed(4)} ${st.currency} × ${st._fxRate.toFixed(4)} = ${st._stSek.toFixed(2)} SEK vs ${fnSek.toFixed(2)} SEK (${diff.toFixed(2)}%)`]);
        usedStIds.add(st.id);
        matched++;
      } else {
        skipped++;
      }
    }

    await client.query('COMMIT');
    res.json({ matched, skipped });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Tight automatch error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

function addDaysStr(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function toDateStr(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val.toISOString().slice(0, 10);
  const s = String(val).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------
router.get('/matches', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        m.id, m.match_type, m.fx_rate_used, m.notes, m.matched_by, m.matched_at,
        f.id  AS fortnox_id, f.vernr, f.bokforingsdatum, f.verifikationstext,
        f.transaktionsinfo, f.debet AS f_debet, f.kredit AS f_kredit, f.project_currency,
        s.id  AS statement_id, s.source, s.account, s.date AS s_date,
        s.type AS s_type, s.subtype, s.currency, s.amount AS s_amount,
        s.fee, s.transaction_id, s.remark
      FROM recon_matches m
      LEFT JOIN stg_fortnox    f ON f.id = m.fortnox_id
      LEFT JOIN stg_statements s ON s.id = m.statement_id
      ORDER BY m.matched_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/matches', async (req, res) => {
  const { fortnox_id, statement_id, match_type, fx_rate_used, notes, matched_by } = req.body;
  if (!match_type) return res.status(400).json({ error: 'match_type is required' });
  if (!fortnox_id && !statement_id) return res.status(400).json({ error: 'at least one of fortnox_id or statement_id is required' });
  if (!['auto','manual','explained'].includes(match_type)) return res.status(400).json({ error: 'invalid match_type' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO recon_matches (fortnox_id, statement_id, match_type, fx_rate_used, notes, matched_by)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [fortnox_id || null, statement_id || null, match_type, fx_rate_used || null, notes || null, matched_by || 'user']);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/matches/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM recon_matches WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/matches/:id', async (req, res) => {
  const { notes, fx_rate_used } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE recon_matches
      SET notes = COALESCE($1, notes), fx_rate_used = COALESCE($2, fx_rate_used)
      WHERE id = $3 RETURNING *
    `, [notes, fx_rate_used, req.params.id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Stats & debug
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
  try {
    const [fn, st, mx] = await Promise.all([
      pool.query(`SELECT konto, COUNT(*) AS total FROM stg_fortnox WHERE konto IN ('1971','1966') GROUP BY konto`),
      pool.query(`SELECT account, source, COUNT(*) AS total FROM stg_statements GROUP BY account, source ORDER BY account`),
      pool.query(`SELECT match_type, COUNT(*) AS count FROM recon_matches GROUP BY match_type`),
    ]);
    res.json({ fortnox: fn.rows, statements: st.rows, matches: mx.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/debug/fortnox', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT konto, COUNT(*) AS cnt, MIN(bokforingsdatum) AS min_date, MAX(bokforingsdatum) AS max_date
      FROM stg_fortnox GROUP BY konto ORDER BY cnt DESC LIMIT 50
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// GET /api/revaluation?month=2026-05
// For each account+currency, returns:
//   sek_at_tx   — sum of amount × fx_rate on transaction date
//   sek_at_eom  — sum of amount × fx_rate at month-end
//   reval_diff  — sek_at_eom - sek_at_tx
// ---------------------------------------------------------------------------
router.get('/revaluation', async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month parameter required (YYYY-MM)' });
  }

  const [year, mon] = month.split('-').map(Number);
  const firstDay = `${month}-01`;
  // Last day of the month
  const lastDay = new Date(year, mon, 0).toISOString().slice(0, 10);

  try {
    const { rows } = await pool.query(`
      WITH tx AS (
        SELECT
          s.account,
          s.currency,
          s.amount::numeric                        AS amount,
          COALESCE(f.rate_sek, 1)                  AS tx_rate
        FROM stg_statements s
        LEFT JOIN fx_rates f
          ON f.coin = s.currency
         AND f.rate_date = DATE(s.date)
        WHERE DATE(s.date) >= $1::date
          AND DATE(s.date) <= $2::date
      ),
      eom AS (
        SELECT coin, rate_sek AS eom_rate
        FROM fx_rates
        WHERE rate_date = $2::date
      ),
      agg AS (
        SELECT
          tx.account,
          tx.currency,
          SUM(tx.amount)                           AS net_amount,
          SUM(tx.amount * tx.tx_rate)              AS sek_at_tx,
          MAX(eom.eom_rate)                        AS eom_rate
        FROM tx
        LEFT JOIN eom ON eom.coin = tx.currency
        GROUP BY tx.account, tx.currency
      )
      SELECT
        agg.account,
        agg.currency,
        agg.net_amount::float,
        agg.sek_at_tx::float,
        COALESCE(agg.eom_rate, 1)::float           AS eom_rate,
        (agg.net_amount * COALESCE(agg.eom_rate, 1))::float AS sek_at_eom,
        (agg.net_amount * COALESCE(agg.eom_rate, 1) - agg.sek_at_tx)::float AS reval_diff
      FROM agg
      ORDER BY agg.account, ABS(agg.sek_at_tx) DESC
    `, [firstDay, lastDay]);

    res.json({ month, last_day: lastDay, rows });
  } catch (err) {
    console.error('Revaluation error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
