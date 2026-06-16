# Fortnox 1971 ↔ Binance Reconciliation

## Quick start (Docker)

```bash
docker compose up --build
# App: http://localhost:3000
```

## Local dev (no Docker)

```bash
# 1. Start Postgres (or point to an existing one)
docker compose up postgres -d

# 2. Run schema
psql -h localhost -U recon -d recon -f db/init.sql

# 3. Start backend
cd backend
cp ../.env.example .env   # edit as needed
npm install
node server.js
# → http://localhost:3000
```

## Import formats

### Fortnox
Export from Fortnox: Bokföring → Verifikationer → filter Konto 1971 → Export XLS.  
File must be ISO-8859-1 tab-delimited with a header row containing "Vernr" / "Konto".

Columns (by position):
| # | Field |
|---|-------|
| 0 | Vernr |
| 1 | Bokföringsdatum (YYYY-MM-DD) |
| 2 | Konto |
| 3 | Verifikationstext |
| 4 | Transaktionsinfo |
| 5 | Debet |
| 6 | Kredit |
| 7 | Project / currency code |

### Binance
Export from Binance: Transaction History → Generate → CSV.  
Header: `UTC_Time,Account,Operation,Coin,Change,Remark`

## Auto-matching logic

On every import, the backend attempts to auto-match:
- **Fortnox side**: konto=1971, kredit > 0, not yet matched
- **Binance side**: operation LIKE '%withdraw%', coin=USDT, same calendar date, not yet matched
- **Criterion**: `SUM(abs(change)) × implied_rate` within 2% of the SEK kredit amount
- The implied FX rate (SEK/USDT) is stored on each match record

## Redshift migration

Change the environment variables to point at your Redshift cluster.  
All SQL uses standard ANSI syntax — no Postgres-specific extensions.  
Replace `SERIAL` with `INT IDENTITY(1,1)` in the schema if recreating tables on Redshift.
