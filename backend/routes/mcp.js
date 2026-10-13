const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
const { InvalidTokenError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');
const { getOAuthProtectedResourceMetadataUrl } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const z = require('zod');
const { findUserByToken } = require('../lib/apiTokens');

// Accepts either a short-lived OAuth access token (Claude web/Desktop/Cowork,
// issued via lib/oauth.js) or a long-lived static personal API token (Claude
// Code, stored in users.api_token_hash). Both identify a user the same way.
function makeVerifier(pool, oauthProvider) {
  return {
    async verifyAccessToken(token) {
      try {
        return await oauthProvider.verifyAccessToken(token);
      } catch {
        // Not a valid OAuth token — fall back to the static token table.
      }
      const user = await findUserByToken(pool, token);
      if (!user) throw new InvalidTokenError('Invalid or revoked token');
      return {
        token,
        clientId: String(user.id),
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60,
        extra: { userId: user.id, name: user.name },
      };
    },
  };
}

const ACCOUNT_NAMES = {
  '1580': 'Hot Wallet',
  '1963': 'Electrum BTC',
  '1966': 'Kraken',
  '1971': 'Binance',
  '1975': 'Bitfinex',
  '1976': 'Sec Ops',
};

function getServer(pool) {
  const server = new McpServer({ name: 'recon', version: '1.0.0' });

  // ── get_stats ────────────────────────────────────────────────────────────────
  server.registerTool('get_stats', {
    description: 'Get reconciliation statistics — total rows, matched/unmatched counts per account',
    inputSchema: {},
  }, async () => {
    const [fortnox, statements, matches] = await Promise.all([
      pool.query(`SELECT konto, COUNT(*) AS total FROM stg_fortnox GROUP BY konto ORDER BY konto`),
      pool.query(`SELECT account, source, COUNT(*) AS total FROM stg_statements GROUP BY account, source ORDER BY account`),
      pool.query(`SELECT match_type, COUNT(*) AS count FROM recon_matches GROUP BY match_type`),
    ]);
    return { content: [{ type: 'text', text: JSON.stringify({ fortnox: fortnox.rows, statements: statements.rows, matches: matches.rows }, null, 2) }] };
  });

  // ── get_unmatched_statements ──────────────────────────────────────────────────
  server.registerTool('get_unmatched_statements', {
    description: 'Get unmatched statement rows for an account. Returns id, date, type, currency, amount, remark, transaction_id, contra_account, voucher_text.',
    inputSchema: {
      account:  z.string().describe('Account number e.g. 1971 (Binance), 1966 (Kraken), 1975 (Bitfinex), 1580 (Hot Wallet), 1963 (Electrum BTC), 1976 (Sec Ops)'),
      from:     z.string().optional().describe('Start date YYYY-MM-DD'),
      to:       z.string().optional().describe('End date YYYY-MM-DD'),
      type:     z.string().optional().describe('Filter by type e.g. Withdraw, Deposit'),
      currency: z.string().optional().describe('Filter by currency e.g. BTC, ETH, USDT'),
      show_all: z.boolean().optional().describe('Include already-matched rows (default: unmatched only)'),
    },
  }, async ({ account, from, to, type, currency, show_all }) => {
    const params = [account];
    let where = 'WHERE s.account = $1';
    if (from)     { params.push(from);     where += ` AND s.date >= $${params.length}`; }
    if (to)       { params.push(to);       where += ` AND s.date <= $${params.length}::date + interval '1 day'`; }
    if (type)     { params.push(type);     where += ` AND lower(s.type) = lower($${params.length})`; }
    if (currency) { params.push(currency); where += ` AND upper(s.currency) = upper($${params.length})`; }
    if (!show_all) where += ` AND s.contra_account IS NULL`;

    const { rows } = await pool.query(
      `SELECT s.id, s.date, s.type, s.currency, s.amount, s.remark, s.transaction_id,
              s.contra_account, s.voucher_text, s.contra_source
       FROM stg_statements s
       ${where}
       ORDER BY s.date DESC`,
      params,
    );
    const summary = `${rows.length} rows for account ${account} (${ACCOUNT_NAMES[account] || ''})`;
    return { content: [{ type: 'text', text: summary + '\n\n' + JSON.stringify(rows, null, 2) }] };
  });

  // ── get_unmatched_fortnox ─────────────────────────────────────────────────────
  server.registerTool('get_unmatched_fortnox', {
    description: 'Get unmatched Fortnox rows for an account',
    inputSchema: {
      account:  z.string().optional().describe('Fortnox konto e.g. 1971. Defaults to 1971.'),
      from:     z.string().optional().describe('Start date YYYY-MM-DD'),
      to:       z.string().optional().describe('End date YYYY-MM-DD'),
      show_all: z.boolean().optional().describe('Include matched rows'),
    },
  }, async ({ account = '1971', from, to, show_all }) => {
    const params = [account];
    let where = 'WHERE f.konto = $1';
    if (from)     { params.push(from); where += ` AND f.bokforingsdatum >= $${params.length}`; }
    if (to)       { params.push(to);   where += ` AND f.bokforingsdatum <= $${params.length}::date + interval '1 day'`; }
    if (!show_all) where += ` AND NOT EXISTS (SELECT 1 FROM recon_matches rm WHERE rm.fortnox_id = f.id)`;

    const { rows } = await pool.query(
      `SELECT f.id, f.bokforingsdatum AS date, f.konto, f.vernr, f.verifikationstext,
              f.transaktionsinfo, f.debet, f.kredit, f.project_currency
       FROM stg_fortnox f
       ${where}
       ORDER BY f.bokforingsdatum DESC`,
      params,
    );
    const summary = `${rows.length} Fortnox rows for account ${account}`;
    return { content: [{ type: 'text', text: summary + '\n\n' + JSON.stringify(rows, null, 2) }] };
  });

  // ── set_contra ───────────────────────────────────────────────────────────────
  server.registerTool('set_contra', {
    description: 'Set the contra account on a statement row (marks the counterparty account for an internal transfer)',
    inputSchema: {
      id:             z.number().describe('Statement row id'),
      contra_account: z.number().nullable().describe('Contra account number e.g. 1966, or null to clear'),
    },
  }, async ({ id, contra_account }) => {
    const { rows } = await pool.query(
      `UPDATE stg_statements SET contra_account = $1, contra_source = 'manual' WHERE id = $2
       RETURNING id, contra_account, contra_source`,
      [contra_account, id],
    );
    if (!rows.length) return { content: [{ type: 'text', text: `No statement with id ${id}.` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(rows[0], null, 2) }] };
  });

  // ── set_voucher_text ─────────────────────────────────────────────────────────
  server.registerTool('set_voucher_text', {
    description: 'Set the voucher text on a statement row',
    inputSchema: {
      id:           z.number().describe('Statement row id'),
      voucher_text: z.string().nullable().describe('Voucher text, or null to clear'),
    },
  }, async ({ id, voucher_text }) => {
    const { rows } = await pool.query(
      `UPDATE stg_statements SET voucher_text = $1 WHERE id = $2 RETURNING id, voucher_text`,
      [voucher_text, id],
    );
    if (!rows.length) return { content: [{ type: 'text', text: `No statement with id ${id}.` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(rows[0], null, 2) }] };
  });

  // ── run_auto_contra ──────────────────────────────────────────────────────────
  server.registerTool('run_auto_contra', {
    description: 'Check the current Auto Contra status (running, total, done, tagged). To start a new run, use the Recon web UI — the run is long-lived and fire-and-forget.',
    inputSchema: {},
  }, async () => {
    // The auto-contra job state lives in the api.js module scope.
    // We expose read-only status here; triggering a new run is better done
    // via the web UI to avoid losing the progress stream.
    const { getAutoContraState } = require('./api');
    return { content: [{ type: 'text', text: JSON.stringify(getAutoContraState(), null, 2) }] };
  });

  return server;
}

// Mounts the MCP endpoint on an existing Express app. Stateless mode: a
// fresh McpServer + transport per request, matching the SDK's own
// recommended pattern for simple API-style servers (no session tracking).
function mountMcp(app, pool, { oauthProvider, mcpResourceUrl }) {
  app.use('/mcp', requireBearerAuth({
    verifier: makeVerifier(pool, oauthProvider),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl),
  }));

  app.post('/mcp', async (req, res) => {
    try {
      const server = getServer(pool);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request error', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}

module.exports = { mountMcp };
