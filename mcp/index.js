#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { basename, extname } from 'path';

const BASE_URL = process.env.RECON_URL || 'https://recon.businesscontrol.se';
const API_KEY  = process.env.RECON_API_KEY;

if (!API_KEY) {
  process.stderr.write('ERROR: RECON_API_KEY env var is required\n');
  process.exit(1);
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: { 'X-Api-Key': API_KEY, ...opts.headers },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

const ACCOUNT_NAMES = {
  '1580': 'Hot Wallet',
  '1963': 'Electrum BTC',
  '1966': 'Kraken',
  '1971': 'Binance',
  '1975': 'Bitfinex',
  '1976': 'Sec Ops',
};

const server = new McpServer({ name: 'recon', version: '1.0.0' });

// ── get_stats ────────────────────────────────────────────────────────────────
server.tool(
  'get_stats',
  'Get reconciliation statistics — total rows, matched/unmatched counts per account',
  {},
  async () => {
    const data = await apiFetch('/api/stats');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// ── get_unmatched_statements ──────────────────────────────────────────────────
server.tool(
  'get_unmatched_statements',
  'Get unmatched statement rows for an account. Returns id, date, type, currency, amount, remark, transaction_id, contra_account, voucher_text.',
  {
    account:  z.string().describe('Account number e.g. 1971 (Binance), 1966 (Kraken), 1975 (Bitfinex), 1580 (Hot Wallet), 1963 (Electrum BTC), 1976 (Sec Ops)'),
    from:     z.string().optional().describe('Start date YYYY-MM-DD'),
    to:       z.string().optional().describe('End date YYYY-MM-DD'),
    type:     z.string().optional().describe('Filter by type e.g. Withdraw, Deposit'),
    currency: z.string().optional().describe('Filter by currency e.g. BTC, ETH, USDT'),
    show_all: z.boolean().optional().describe('Include already-matched rows (default: unmatched only)'),
  },
  async ({ account, from, to, type, currency, show_all }) => {
    const p = new URLSearchParams({ account });
    if (from)     p.set('from', from);
    if (to)       p.set('to', to);
    if (show_all) p.set('show', 'all');
    let rows = await apiFetch(`/api/unmatched/statements?${p}`);
    if (type)     rows = rows.filter(r => r.type?.toLowerCase() === type.toLowerCase());
    if (currency) rows = rows.filter(r => r.currency?.toUpperCase() === currency.toUpperCase());
    const summary = `${rows.length} rows for account ${account} (${ACCOUNT_NAMES[account] || ''})`;
    return { content: [{ type: 'text', text: summary + '\n\n' + JSON.stringify(rows, null, 2) }] };
  },
);

// ── get_unmatched_fortnox ─────────────────────────────────────────────────────
server.tool(
  'get_unmatched_fortnox',
  'Get unmatched Fortnox rows for an account',
  {
    account:  z.string().optional().describe('Fortnox konto e.g. 1971. Defaults to 1971.'),
    from:     z.string().optional().describe('Start date YYYY-MM-DD'),
    to:       z.string().optional().describe('End date YYYY-MM-DD'),
    show_all: z.boolean().optional().describe('Include matched rows'),
  },
  async ({ account = '1971', from, to, show_all }) => {
    const p = new URLSearchParams({ account });
    if (from)     p.set('from', from);
    if (to)       p.set('to', to);
    if (show_all) p.set('show', 'all');
    const rows = await apiFetch(`/api/unmatched/fortnox?${p}`);
    const summary = `${rows.length} Fortnox rows for account ${account}`;
    return { content: [{ type: 'text', text: summary + '\n\n' + JSON.stringify(rows, null, 2) }] };
  },
);

// ── set_contra ───────────────────────────────────────────────────────────────
server.tool(
  'set_contra',
  'Set the contra account on a statement row (marks the counterparty account for an internal transfer)',
  {
    id:              z.number().describe('Statement row id'),
    contra_account:  z.number().nullable().describe('Contra account number e.g. 1966, or null to clear'),
  },
  async ({ id, contra_account }) => {
    await apiFetch(`/api/statements/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contra_account }),
    });
    return { content: [{ type: 'text', text: `Statement ${id} contra_account set to ${contra_account ?? 'null'}` }] };
  },
);

// ── set_voucher_text ─────────────────────────────────────────────────────────
server.tool(
  'set_voucher_text',
  'Set the voucher text on a statement row',
  {
    id:           z.number().describe('Statement row id'),
    voucher_text: z.string().nullable().describe('Voucher text, or null to clear'),
  },
  async ({ id, voucher_text }) => {
    await apiFetch(`/api/statements/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voucher_text }),
    });
    return { content: [{ type: 'text', text: `Statement ${id} voucher_text set` }] };
  },
);

// ── run_auto_contra ──────────────────────────────────────────────────────────
server.tool(
  'run_auto_contra',
  'Run Auto Contra — automatically tag contra accounts on inter-account transfers using txid and time/amount matching',
  {
    from: z.string().optional().describe('Limit to date range start YYYY-MM-DD'),
    to:   z.string().optional().describe('Limit to date range end YYYY-MM-DD'),
  },
  async ({ from, to }) => {
    const data = await apiFetch('/api/auto-contra', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from || null, to: to || null }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// ── import_file ──────────────────────────────────────────────────────────────
const IMPORT_TYPES = ['fortnox', 'binance', 'kraken', 'bitfinex', 'secops', 'operational', 'hotwallet'];

server.tool(
  'import_file',
  'Import a data file into recon. Reads a local file and uploads it to the appropriate importer.',
  {
    file_path:   z.string().describe('Absolute path to the file on disk'),
    import_type: z.enum(IMPORT_TYPES).describe('Which importer to use: fortnox, binance, kraken, bitfinex, secops, operational, hotwallet'),
  },
  async ({ file_path, import_type }) => {
    const buf      = readFileSync(file_path);
    const filename = basename(file_path);
    const mime     = extname(filename).toLowerCase() === '.xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv';

    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), filename);

    const res = await fetch(`${BASE_URL}/import/${import_type}`, {
      method: 'POST',
      headers: { 'X-Api-Key': API_KEY },
      body: form,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(`Import failed ${res.status}: ${text}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// ── start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
