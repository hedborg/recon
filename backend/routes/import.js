const express = require('express');
const multer  = require('multer');
const iconv   = require('iconv-lite');
const { parse } = require('csv-parse/sync');
const pool    = require('../db');
const { getRateSek } = require('../fx');

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// Fortnox import  (ISO-8859-1, tab-delimited)
// ---------------------------------------------------------------------------
router.post('/fortnox', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const text = iconv.decode(req.file.buffer, 'iso-8859-1');
    const lines = text.split(/\r?\n/);

    // Find header row
    let headerIdx = lines.findIndex(l => {
      const lower = l.toLowerCase();
      return (lower.includes('konto') || lower.includes('account')) &&
             (lower.includes('vernr') || lower.includes('datum') || lower.includes('debet') || lower.includes('kredit'));
    });
    if (headerIdx === -1) headerIdx = 0;

    const headers = lines[headerIdx].split('\t').map(h => h.trim().toLowerCase()
      .replace(/ö/g, 'o').replace(/å/g, 'a').replace(/ä/g, 'a')
    );

    const col = (aliases) => {
      for (const a of aliases) {
        const i = headers.findIndex(h => h.includes(a));
        if (i !== -1) return i;
      }
      return -1;
    };

    const iVernr   = col(['vernr', 'ver.nr', 'ver nr', 'serie']);
    const iDatum   = col(['bokforingsdatum', 'datum', 'date', 'bokf']);
    const iKonto   = col(['konto']);
    const iVerText = col(['verifikationstext', 'vertext', 'text', 'beskrivning']);
    const iTrans   = col(['transaktionsinfo', 'trans']);
    const iDebet   = col(['debet']);
    const iKredit  = col(['kredit']);
    const iProj    = col(['projekt', 'projnr', 'project', 'valuta', 'currency', 'curr']);

    console.log('Fortnox header mapping:', { headers, iVernr, iDatum, iKonto, iVerText, iTrans, iDebet, iKredit, iProj });

    const dataLines = lines.slice(headerIdx + 1).filter(l => l.trim());
    const client = await pool.connect();
    let inserted = 0, skipped = 0;

    try {
      // Fetch all VERNRs already in the DB so we can skip duplicates
      const { rows: existingRows } = await client.query('SELECT DISTINCT vernr FROM stg_fortnox WHERE vernr IS NOT NULL');
      const existingVernrs = new Set(existingRows.map(r => r.vernr));

      await client.query('BEGIN');
      for (const line of dataLines) {
        const cols = line.split('\t');
        if (cols.length < 3) { skipped++; continue; }
        const get = (i) => i >= 0 ? (cols[i]?.trim() || null) : null;
        const konto = get(iKonto);
        if (!konto) { skipped++; continue; }
        const vernr = get(iVernr);
        if (vernr && existingVernrs.has(vernr)) { skipped++; continue; }
        await client.query(
          `INSERT INTO stg_fortnox (vernr, bokforingsdatum, konto, verifikationstext, transaktionsinfo, debet, kredit, project_currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [vernr, parseSwedishDate(get(iDatum)), konto, get(iVerText), get(iTrans),
           parseSEK(get(iDebet)), parseSEK(get(iKredit)), get(iProj)]
        );
        inserted++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK'); throw err;
    } finally { client.release(); }

    const matched = await runAutoMatch();
    res.json({ inserted, skipped, auto_matched: matched });
  } catch (err) {
    console.error('Fortnox import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Binance import  (UTF-8 CSV)
// Columns: UTC_Time / Time, Account, Operation, Coin, Change, Remark
// Maps to stg_statements with source='Binance', account='1971'
// ---------------------------------------------------------------------------
router.post('/binance', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const text = req.file.buffer.toString('utf8');
    const records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });

    const valueBatch = [];
    let skipped = 0;

    for (const r of records) {
      const rawTime  = r['UTC_Time'] || r['utc_time'] || r['Time'] || r['time'] || null;
      const date     = parseBinanceTime(rawTime);
      const type     = r['Operation'] || r['operation'] || null;
      const currency = r['Coin']      || r['coin']      || null;
      const amount   = parseFloat((r['Change'] || r['change'] || '0').replace(/,/g, '')) || 0;
      const remark   = r['Remark']    || r['remark']    || null;
      if (!date) { skipped++; continue; }
      valueBatch.push([date, type, currency, amount, remark]);
    }

    const client = await pool.connect();
    const BATCH = 500;
    let inserted = 0;

    try {
      // Find the latest timestamp already imported for this source
      const { rows: [latestRow] } = await client.query(
        `SELECT MAX(date) as max_date FROM stg_statements WHERE source = 'Binance' AND account = '1971'`
      );
      const maxDate = latestRow?.max_date ? new Date(latestRow.max_date) : null;

      // For rows at exactly the boundary timestamp, build a fingerprint set to detect duplicates
      const boundaryFingerprints = new Set();
      if (maxDate) {
        const { rows: boundaryRows } = await client.query(
          `SELECT date, currency, amount FROM stg_statements WHERE source = 'Binance' AND account = '1971' AND date = $1`,
          [maxDate]
        );
        for (const br of boundaryRows) {
          boundaryFingerprints.add(`${new Date(br.date).toISOString()}|${br.currency}|${parseFloat(br.amount)}`);
        }
      }

      await client.query('BEGIN');
      for (let i = 0; i < valueBatch.length; i += BATCH) {
        const chunk = valueBatch.slice(i, i + BATCH);
        for (const row of chunk) {
          const [date, type, currency, amount, remark] = row;
          const rowDate = new Date(date);
          if (maxDate) {
            if (rowDate < maxDate) { skipped++; continue; }
            if (rowDate.getTime() === maxDate.getTime()) {
              const fp = `${rowDate.toISOString()}|${currency}|${amount}`;
              if (boundaryFingerprints.has(fp)) { skipped++; continue; }
            }
          }
          await client.query(
            `INSERT INTO stg_statements (source, account, date, type, currency, amount, remark) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            ['Binance', '1971', date, type, currency, amount, remark]
          );
          inserted++;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK'); throw err;
    } finally { client.release(); }

    const matched = await runAutoMatch();
    res.json({ inserted, skipped, auto_matched: matched });
  } catch (err) {
    console.error('Binance import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Kraken import  (UTF-8 CSV)
// Columns: txid, refid, time, type, subtype, aclass, subclass, asset, wallet, amount, fee, balance
// Only imports type = 'deposit' or 'withdrawal'
// Net amount = amount - fee
// Maps to stg_statements with source='Kraken', account='1966'
// ---------------------------------------------------------------------------
router.post('/kraken', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const text = req.file.buffer.toString('utf8');
    const records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });

    const valueBatch = [];
    let skipped = 0;

    for (const r of records) {
      const type = (r['type'] || '').toLowerCase();

      // Only import deposit and withdrawal — trades are zero-sum, skip them
      if (type !== 'deposit' && type !== 'withdrawal') { skipped++; continue; }

      const date     = r['time'] || null;         // "YYYY-MM-DD HH:MM:SS" — Postgres handles this
      const subtype  = r['subtype'] || null;
      const currency = r['asset']  || null;
      const rawAmt   = parseFloat(r['amount'] || '0') || 0;
      const fee      = parseFloat(r['fee']    || '0') || 0;
      const amount   = rawAmt - fee;              // net
      const txid     = r['txid']   || null;

      if (!date || !currency) { skipped++; continue; }

      // [date, type, subtype, currency, amount, fee, transaction_id]
      valueBatch.push([date, type, subtype, currency, amount, fee, txid]);
    }

    const client = await pool.connect();
    let inserted = 0;

    try {
      // Pre-load all existing Kraken transaction_ids to skip duplicates
      const { rows: existingTxRows } = await client.query(
        `SELECT transaction_id FROM stg_statements WHERE source = 'Kraken' AND transaction_id IS NOT NULL`
      );
      const existingTxIds = new Set(existingTxRows.map(r => r.transaction_id));

      await client.query('BEGIN');
      for (const row of valueBatch) {
        const [date, type, subtype, currency, amount, fee, txid] = row;
        if (txid && existingTxIds.has(txid)) { skipped++; continue; }
        await client.query(
          `INSERT INTO stg_statements (source, account, date, type, subtype, currency, amount, fee, transaction_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          ['Kraken', '1966', date, type, subtype, currency, amount, fee, txid]
        );
        inserted++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK'); throw err;
    } finally { client.release(); }

    const matched = await runAutoMatch('1966');
    res.json({ inserted, skipped, auto_matched: matched });
  } catch (err) {
    console.error('Kraken import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Bitfinex import  (UTF-8 CSV)
// Columns: #, DESCRIPTION, CURRENCY, AMOUNT, BALANCE, DATE, WALLET
// Date format: DD-MM-YY HH:MM:SS
// Maps to stg_statements with source='Bitfinex', account='1975'
// ---------------------------------------------------------------------------
router.post('/bitfinex', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const text = req.file.buffer.toString('utf8');
    const records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });

    const valueBatch = [];
    let skipped = 0;

    for (const r of records) {
      const txid     = r['#'] || null;
      const desc     = r['DESCRIPTION'] || r['description'] || '';
      const currency = r['CURRENCY'] || r['currency'] || null;
      const amount   = parseFloat(r['AMOUNT'] || r['amount'] || '0') || 0;
      const rawDate  = r['DATE'] || r['date'] || null;
      const wallet   = r['WALLET'] || r['wallet'] || null;

      const date = parseBitfinexDate(rawDate);
      if (!date || !currency) { skipped++; continue; }

      // Extract type from start of description (e.g. "Deposit (LNX) #..." → "Deposit")
      const typeMatch = desc.match(/^([A-Za-z ]+?)(?:\s*[\(#]|$)/);
      const type = typeMatch ? typeMatch[1].trim() : desc.slice(0, 40);

      valueBatch.push([txid, date, type, currency, amount, wallet, desc]);
    }

    const client = await pool.connect();
    let inserted = 0;

    try {
      // Dedup by transaction_id
      const { rows: existingTxRows } = await client.query(
        `SELECT transaction_id FROM stg_statements WHERE source = 'Bitfinex' AND transaction_id IS NOT NULL`
      );
      const existingTxIds = new Set(existingTxRows.map(r => r.transaction_id));

      await client.query('BEGIN');
      for (const [txid, date, type, currency, amount, wallet, desc] of valueBatch) {
        if (txid && existingTxIds.has(txid)) { skipped++; continue; }
        await client.query(
          `INSERT INTO stg_statements (source, account, date, type, subtype, currency, amount, transaction_id, remark)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          ['Bitfinex', '1975', date, type, wallet, currency, amount, txid, desc]
        );
        inserted++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK'); throw err;
    } finally { client.release(); }

    const matched = await runAutoMatch('1975');
    res.json({ inserted, skipped, auto_matched: matched });
  } catch (err) {
    console.error('Bitfinex import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sec Ops Wallet BTC import (account 1976)
// CSV columns: oc_transaction_hash, ln_payment_hash, label, confirmations,
//              amount_chain_bc, amount_lightning_bc, fiat_value,
//              network_fee_satoshi, fiat_fee, timestamp
// Only rows with timestamp >= 2026-01-01 are imported.
// ---------------------------------------------------------------------------
router.post('/secops', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const CUTOFF = new Date('2026-01-01T00:00:00Z');

  try {
    const text = req.file.buffer.toString('utf8');
    const records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });

    const valueBatch = [];
    let skipped = 0;

    for (const r of records) {
      const rawDate = r['timestamp'] || r['Timestamp'] || null;
      if (!rawDate) { skipped++; continue; }

      const date = new Date(rawDate);
      if (isNaN(date.getTime()) || date < CUTOFF) { skipped++; continue; }

      const txid    = r['oc_transaction_hash'] || r['ln_payment_hash'] || null;
      const label   = r['label'] || null;

      // Combine on-chain and lightning amounts (one is always 0)
      const chainAmt   = parseFloat(r['amount_chain_bc']     || '0') || 0;
      const lnAmt      = parseFloat(r['amount_lightning_bc'] || '0') || 0;
      const amount     = chainAmt + lnAmt;

      valueBatch.push([txid, date, amount, label]);
    }

    const client = await pool.connect();
    let inserted = 0;

    try {
      const { rows: existingTxRows } = await client.query(
        `SELECT transaction_id FROM stg_statements WHERE source = 'SecOps' AND transaction_id IS NOT NULL`
      );
      const existingTxIds = new Set(existingTxRows.map(r => r.transaction_id));

      await client.query('BEGIN');
      for (const [txid, date, amount, label] of valueBatch) {
        if (txid && existingTxIds.has(txid)) { skipped++; continue; }
        await client.query(
          `INSERT INTO stg_statements (source, account, date, type, currency, amount, transaction_id, remark)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          ['SecOps', '1976', date, amount >= 0 ? 'Deposit' : 'Withdrawal', 'BTC', amount, txid, label]
        );
        inserted++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK'); throw err;
    } finally { client.release(); }

    const matched = await runAutoMatch('1976');
    res.json({ inserted, skipped, auto_matched: matched });
  } catch (err) {
    console.error('SecOps import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Operational Wallet BTC import (account 1963) — same CSV format as SecOps
// ---------------------------------------------------------------------------
router.post('/operational', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const CUTOFF = new Date('2026-01-01T00:00:00Z');

  try {
    const text = req.file.buffer.toString('utf8');
    const records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });

    const valueBatch = [];
    let skipped = 0;

    for (const r of records) {
      const rawDate = r['timestamp'] || r['Timestamp'] || null;
      if (!rawDate) { skipped++; continue; }

      const date = new Date(rawDate);
      if (isNaN(date.getTime()) || date < CUTOFF) { skipped++; continue; }

      const txid   = r['oc_transaction_hash'] || r['ln_payment_hash'] || null;
      const label  = r['label'] || null;
      const chainAmt = parseFloat(r['amount_chain_bc']     || '0') || 0;
      const lnAmt    = parseFloat(r['amount_lightning_bc'] || '0') || 0;
      const amount   = chainAmt + lnAmt;

      valueBatch.push([txid, date, amount, label]);
    }

    const client = await pool.connect();
    let inserted = 0;

    try {
      const { rows: existingTxRows } = await client.query(
        `SELECT transaction_id FROM stg_statements WHERE source = 'Operational' AND transaction_id IS NOT NULL`
      );
      const existingTxIds = new Set(existingTxRows.map(r => r.transaction_id));

      await client.query('BEGIN');
      for (const [txid, date, amount, label] of valueBatch) {
        if (txid && existingTxIds.has(txid)) { skipped++; continue; }
        await client.query(
          `INSERT INTO stg_statements (source, account, date, type, currency, amount, transaction_id, remark)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          ['Operational', '1963', date, amount >= 0 ? 'Deposit' : 'Withdrawal', 'BTC', amount, txid, label]
        );
        inserted++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK'); throw err;
    } finally { client.release(); }

    const matched = await runAutoMatch('1963');
    res.json({ inserted, skipped, auto_matched: matched });
  } catch (err) {
    console.error('Operational import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Auto-matching
// Matches unmatched Fortnox kredit lines for a given konto against unmatched
// statement rows for the same account, using FX conversion to SEK.
// ---------------------------------------------------------------------------
async function runAutoMatch(account = '1971') {
  const konto = account; // Fortnox konto matches the account field
  const client = await pool.connect();
  let matchCount = 0;

  try {
    await client.query('BEGIN');

    const { rows: fnRows } = await client.query(`
      SELECT f.id, f.bokforingsdatum, f.kredit, f.vernr
      FROM stg_fortnox f
      WHERE f.konto = $1
        AND f.kredit > 0
        AND NOT EXISTS (SELECT 1 FROM recon_matches m WHERE m.fortnox_id = f.id)
      ORDER BY f.bokforingsdatum
    `, [konto]);

    for (const fn of fnRows) {
      const dateStr = fn.bokforingsdatum instanceof Date
        ? fn.bokforingsdatum.toISOString().slice(0, 10)
        : String(fn.bokforingsdatum).slice(0, 10);
      const fnSek = parseFloat(fn.kredit);

      const { rows: stRows } = await client.query(`
        SELECT s.id, s.amount, s.currency, s.date
        FROM stg_statements s
        WHERE s.account = $1
          AND DATE(s.date) = $2::date
          AND NOT EXISTS (SELECT 1 FROM recon_matches m WHERE m.statement_id = s.id)
        ORDER BY s.currency, s.date
      `, [account, dateStr]);

      if (stRows.length === 0) continue;

      // Group by currency
      const byCurrency = {};
      for (const st of stRows) {
        (byCurrency[st.currency] = byCurrency[st.currency] || []).push(st);
      }

      let matched = false;
      for (const [currency, rows] of Object.entries(byCurrency)) {
        if (matched) break;
        const fxRate = await getRateSek(currency, dateStr);
        if (!fxRate) continue;

        // Try individual row match (within 2%)
        for (const st of rows) {
          const stSek = Math.abs(parseFloat(st.amount)) * fxRate;
          const diff  = Math.abs(fnSek - stSek) / fnSek;
          if (diff <= 0.02) {
            await client.query(`
              INSERT INTO recon_matches (fortnox_id, statement_id, match_type, fx_rate_used, notes, matched_by)
              VALUES ($1,$2,'auto',$3,$4,'system')
            `, [fn.id, st.id, fxRate.toFixed(6),
                `Auto: ${Math.abs(parseFloat(st.amount)).toFixed(4)} ${currency} × ${fxRate.toFixed(4)} = ${stSek.toFixed(2)} SEK vs ${fnSek.toFixed(2)} (${(diff*100).toFixed(2)}%)`]);
            matchCount++;
            matched = true;
            break;
          }
        }

        // Try sum of same-currency rows for the day (within 2%)
        if (!matched) {
          const sumSek = rows.reduce((s, r) => s + Math.abs(parseFloat(r.amount)) * fxRate, 0);
          const diff   = Math.abs(fnSek - sumSek) / fnSek;
          if (diff <= 0.02) {
            for (const st of rows) {
              await client.query(`
                INSERT INTO recon_matches (fortnox_id, statement_id, match_type, fx_rate_used, notes, matched_by)
                VALUES ($1,$2,'auto',$3,$4,'system')
              `, [fn.id, st.id, fxRate.toFixed(6),
                  `Auto (sum ${rows.length}): Σ ${sumSek.toFixed(2)} SEK vs ${fnSek.toFixed(2)} (${(diff*100).toFixed(2)}%)`]);
              matchCount++;
            }
            matched = true;
          }
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Auto-match error:', err);
  } finally {
    client.release();
  }

  return matchCount;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseBinanceTime(s) {
  if (!s) return null;
  s = s.trim();
  // Binance 2-digit year: "25-12-31 02:01:04"
  if (/^\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return '20' + s.replace(' ', 'T') + 'Z';
  }
  return s;
}

function parseBitfinexDate(s) {
  if (!s) return null;
  // Format: DD-MM-YY HH:MM:SS  e.g. "01-06-26 05:19:59"
  const m = s.trim().match(/^(\d{2})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yy, time] = m;
  return `20${yy}-${mm}-${dd}T${time}Z`;
}

function parseSwedishDate(s) {
  if (!s) return null;
  const clean = s.replace(/[^\d-]/g, '');
  if (/^\d{8}$/.test(clean)) {
    return `${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}`;
  }
  return clean || null;
}

function parseSEK(s) {
  if (!s || s.trim() === '') return 0;
  return parseFloat(s.trim().replace(/\s/g, '').replace(',', '.')) || 0;
}

module.exports = router;
