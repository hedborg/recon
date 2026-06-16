const express = require('express');
const path    = require('path');
const pool    = require('./db');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { console.log(req.method, req.url); next(); });

// PUBLIC_DIR can be overridden; Docker mounts frontend at /app/public
const publicDir = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'frontend');
app.use(express.static(publicDir));

app.use('/import',  require('./routes/import'));
app.use('/api',     require('./routes/api'));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Migrations — run on every startup, idempotent
// ---------------------------------------------------------------------------
async function migrate() {

  // ── M1: fx_rates ────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fx_rates (
      coin        TEXT          NOT NULL,
      rate_date   DATE          NOT NULL,
      rate_sek    NUMERIC(28,8) NOT NULL,
      source      TEXT,
      fetched_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (coin, rate_date)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fx_rates_date ON fx_rates(rate_date)`);

  // ── M2: stg_binance → stg_statements (runs once, then stg_binance gone) ─
  const { rows: hasBinance } = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'stg_binance'
  `);

  if (hasBinance.length) {
    console.log('M2: migrating stg_binance → stg_statements …');

    // Drop old FK so we can rename freely
    await pool.query(`ALTER TABLE recon_matches DROP CONSTRAINT IF EXISTS recon_matches_binance_id_fkey`);

    // Rename table
    await pool.query(`ALTER TABLE stg_binance RENAME TO stg_statements`);

    // Rename columns to normalised names
    await pool.query(`ALTER TABLE stg_statements RENAME COLUMN utc_time   TO date`);
    await pool.query(`ALTER TABLE stg_statements RENAME COLUMN coin       TO currency`);
    await pool.query(`ALTER TABLE stg_statements RENAME COLUMN "change"   TO amount`);
    await pool.query(`ALTER TABLE stg_statements RENAME COLUMN operation  TO type`);

    // Rename binance_id → statement_id on matches
    const { rows: hasCol } = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name='recon_matches' AND column_name='binance_id'
    `);
    if (hasCol.length) {
      await pool.query(`ALTER TABLE recon_matches RENAME COLUMN binance_id TO statement_id`);
    }

    // Add new columns
    await pool.query(`ALTER TABLE stg_statements ADD COLUMN IF NOT EXISTS source         TEXT`);
    await pool.query(`ALTER TABLE stg_statements ADD COLUMN IF NOT EXISTS account        TEXT`);
    await pool.query(`ALTER TABLE stg_statements ADD COLUMN IF NOT EXISTS subtype        TEXT`);
    await pool.query(`ALTER TABLE stg_statements ADD COLUMN IF NOT EXISTS fee            NUMERIC(28,8)`);
    await pool.query(`ALTER TABLE stg_statements ADD COLUMN IF NOT EXISTS transaction_id TEXT`);

    // Backfill
    await pool.query(`UPDATE stg_statements SET source = 'Binance', account = '1971' WHERE source IS NULL`);

    // Make NOT NULL now that values are set
    await pool.query(`ALTER TABLE stg_statements ALTER COLUMN source  SET NOT NULL`);
    await pool.query(`ALTER TABLE stg_statements ALTER COLUMN account SET NOT NULL`);

    // Restore FK on matches
    await pool.query(`
      ALTER TABLE recon_matches
        ADD CONSTRAINT recon_matches_statement_id_fkey
        FOREIGN KEY (statement_id) REFERENCES stg_statements(id)
    `);

    // Fix match_type constraint (was VARCHAR, now TEXT)
    await pool.query(`ALTER TABLE recon_matches DROP CONSTRAINT IF EXISTS recon_matches_match_type_check`);
    await pool.query(`ALTER TABLE recon_matches ADD CONSTRAINT recon_matches_match_type_check CHECK (match_type IN ('auto','manual','explained'))`);

    // Swap indexes
    await pool.query(`DROP INDEX IF EXISTS idx_binance_utctime`);
    await pool.query(`DROP INDEX IF EXISTS idx_binance_op`);
    await pool.query(`DROP INDEX IF EXISTS idx_recon_binance`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stmt_source    ON stg_statements(source)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stmt_account   ON stg_statements(account)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stmt_date      ON stg_statements(date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stmt_currency  ON stg_statements(currency, date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_recon_statement ON recon_matches(statement_id)`);

    console.log('M2: done');
  }

  // ── M2b: rename operation→type if the column rename was missed ───────────
  const { rows: hasOperation } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name='stg_statements' AND column_name='operation'
  `);
  if (hasOperation.length) {
    console.log('M2b: renaming operation → type');
    await pool.query(`ALTER TABLE stg_statements RENAME COLUMN operation TO type`);
  }

  // ── M3: fresh install — create stg_statements if it doesn't exist ───────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stg_statements (
      id               SERIAL PRIMARY KEY,
      source           TEXT      NOT NULL,
      account          TEXT      NOT NULL,
      date             TIMESTAMP NOT NULL,
      type             TEXT,
      subtype          TEXT,
      currency         TEXT,
      amount           NUMERIC(28,8),
      fee              NUMERIC(28,8),
      transaction_id   TEXT,
      remark           TEXT,
      imported_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stmt_source    ON stg_statements(source)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stmt_account   ON stg_statements(account)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stmt_date      ON stg_statements(date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stmt_currency  ON stg_statements(currency, date)`);

  // ── M4: ensure recon_matches has statement_id (fresh install) ───────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recon_matches (
      id              SERIAL PRIMARY KEY,
      fortnox_id      INTEGER REFERENCES stg_fortnox(id),
      statement_id    INTEGER REFERENCES stg_statements(id),
      match_type      TEXT NOT NULL CHECK (match_type IN ('auto','manual','explained')),
      fx_rate_used    NUMERIC(18,6),
      notes           TEXT,
      matched_by      TEXT,
      matched_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recon_fortnox   ON recon_matches(fortnox_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recon_statement ON recon_matches(statement_id)`);

  // ── M5: chart_of_accounts + seed ────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chart_of_accounts (
      account_number INTEGER PRIMARY KEY CHECK (account_number BETWEEN 1000 AND 9999),
      account_name   TEXT NOT NULL,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const seedAccounts = [
    [1920, 'Svea bank'],
    [1932, 'Mynt'],
    [1933, 'Revolut business account EUR'],
    [1934, 'Revolut business account USD'],
    [1935, 'Revolut business account SEK'],
    [1936, 'Revolut Business Account GBP'],
    [1937, 'Revolut Business Account CAD'],
    [1938, 'Revolut Business Account AUD'],
    [1950, 'Striga'],
    [1956, 'ClearJunction GBP'],
    [1957, 'ClearJunction EUR'],
    [1963, 'Electrum BTC wallet 2018'],
    [1966, 'Kraken'],
    [1971, 'Binance Exchange'],
    [1975, 'Bitfinex Exchange'],
    [1976, 'Sec Ops Wallet BTC'],
    [1978, 'Galaxy OTC'],
    [1979, 'Bitwage balance account'],
    [1580, 'Hot Wallet'],
    [1613, 'Marketing Wallet'],
    [6042, 'Transaction Costs'],
    [6570, 'Banking Costs'],
    [3100, 'Gross Product Value'],
    [2423, 'Store Credit'],
  ];
  for (const [num, name] of seedAccounts) {
    await pool.query(`
      INSERT INTO chart_of_accounts (account_number, account_name)
      VALUES ($1, $2) ON CONFLICT (account_number) DO NOTHING
    `, [num, name]);
  }

  // ── M6: contra_account + voucher_text on stg_statements ─────────
  await pool.query(`ALTER TABLE stg_statements ADD COLUMN IF NOT EXISTS contra_account INTEGER REFERENCES chart_of_accounts(account_number)`);
  await pool.query(`ALTER TABLE stg_statements ADD COLUMN IF NOT EXISTS voucher_text   TEXT`);

  console.log('Migrations OK');
}

migrate()
  .then(() => app.listen(PORT, () => console.log(`Recon app running on port ${PORT}`)))
  .catch(err => { console.error('Migration failed:', err); process.exit(1); });
