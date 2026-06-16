-- ---------------------------------------------------------------------------
-- stg_fortnox  — Fortnox voucher lines (all accounts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stg_fortnox (
    id                SERIAL PRIMARY KEY,
    vernr             TEXT,
    bokforingsdatum   DATE,
    konto             TEXT,
    verifikationstext TEXT,
    transaktionsinfo  TEXT,
    debet             NUMERIC(18,2),
    kredit            NUMERIC(18,2),
    project_currency  TEXT,
    imported_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- stg_statements  — normalised exchange statement rows (all sources)
--
-- source        : 'Binance', 'Kraken', …
-- account       : Fortnox konto this exchange maps to, e.g. '1971', '1966'
-- date          : transaction timestamp (UTC)
-- type          : deposit | withdrawal | trade | …
-- subtype       : e.g. tradespot (Kraken); NULL for Binance
-- currency      : asset / coin symbol, e.g. BTC, ETH, USDT, EUR
-- amount        : net transaction amount (change for Binance; amount-fee for Kraken)
-- fee           : original fee (NULL for Binance)
-- transaction_id: exchange-side txid (Kraken txid; NULL for Binance)
-- remark        : free-text note (Binance remark; NULL for Kraken)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stg_statements (
    id               SERIAL PRIMARY KEY,
    source           TEXT          NOT NULL,
    account          TEXT          NOT NULL,
    date             TIMESTAMP     NOT NULL,
    type             TEXT,
    subtype          TEXT,
    currency         TEXT,
    amount           NUMERIC(28,8),
    fee              NUMERIC(28,8),
    transaction_id   TEXT,
    remark           TEXT,
    imported_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- recon_matches  — confirmed links between Fortnox lines and statement rows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recon_matches (
    id              SERIAL PRIMARY KEY,
    fortnox_id      INTEGER REFERENCES stg_fortnox(id),
    statement_id    INTEGER REFERENCES stg_statements(id),
    match_type      TEXT NOT NULL CHECK (match_type IN ('auto','manual','explained')),
    fx_rate_used    NUMERIC(18,6),
    notes           TEXT,
    matched_by      TEXT,
    matched_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- fx_rates  — cached historical FX rates (SEK per 1 unit of currency)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_rates (
    coin        TEXT          NOT NULL,
    rate_date   DATE          NOT NULL,
    rate_sek    NUMERIC(28,8) NOT NULL,
    source      TEXT,
    fetched_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (coin, rate_date)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_fortnox_konto      ON stg_fortnox(konto);
CREATE INDEX IF NOT EXISTS idx_fortnox_datum      ON stg_fortnox(bokforingsdatum);
CREATE INDEX IF NOT EXISTS idx_stmt_source        ON stg_statements(source);
CREATE INDEX IF NOT EXISTS idx_stmt_account       ON stg_statements(account);
CREATE INDEX IF NOT EXISTS idx_stmt_date          ON stg_statements(date);
CREATE INDEX IF NOT EXISTS idx_stmt_currency      ON stg_statements(currency, date);
CREATE INDEX IF NOT EXISTS idx_recon_fortnox      ON recon_matches(fortnox_id);
CREATE INDEX IF NOT EXISTS idx_recon_statement    ON recon_matches(statement_id);
CREATE INDEX IF NOT EXISTS idx_fx_rates_date      ON fx_rates(rate_date);
