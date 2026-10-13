const crypto = require('crypto');
const { AccessDeniedError, InvalidGrantError, InvalidTokenError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');
const { attemptLogin } = require('../routes/auth');

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour — refresh tokens make this seamless
const AUTH_CODE_TTL_SECONDS = 5 * 60;

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rowToClient(row) {
  return {
    client_id: row.client_id,
    client_secret: row.client_secret || undefined,
    client_id_issued_at: Number(row.client_id_issued_at),
    client_secret_expires_at: row.client_secret_expires_at != null ? Number(row.client_secret_expires_at) : undefined,
    redirect_uris: row.redirect_uris,
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    grant_types: row.grant_types || undefined,
    response_types: row.response_types || undefined,
    client_name: row.client_name || undefined,
    scope: row.scope || undefined,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hiddenAuthFields(client, params) {
  const fields = {
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  };
  if (params.state) fields.state = params.state;
  if (params.scopes && params.scopes.length) fields.scope = params.scopes.join(' ');
  if (params.resource) fields.resource = params.resource.href;
  return Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n');
}

function pageShell(title, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.08); padding: 2rem; width: 320px; }
  h1 { font-size: 1.1rem; margin: 0 0 1.2rem; }
  label { display: block; font-size: .85rem; color: #444; margin: .8rem 0 .3rem; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: .5rem; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; }
  button { width: 100%; padding: .6rem; margin-top: 1.2rem; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
  .primary { background: #2563eb; color: #fff; }
  .secondary { background: #eee; color: #333; margin-top: .5rem; }
  .error { color: #b91c1c; font-size: .85rem; margin-top: .8rem; }
  .who { font-size: .85rem; color: #555; margin-bottom: 1rem; }
</style></head>
<body><div class="card">${body}</div></body></html>`;
}

function renderLoginPage(res, { client, params, error }) {
  res.status(error ? 401 : 200).send(pageShell('Log in — Recon', `
    <h1>Log in to allow <strong>${escapeHtml(client.client_name || client.client_id)}</strong> to access Recon</h1>
    <form method="post">
      ${hiddenAuthFields(client, params)}
      <input type="hidden" name="recon_action" value="login">
      <label>Name</label>
      <input type="text" name="name" autofocus required>
      <label>Password</label>
      <input type="password" name="password" required>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      <button class="primary" type="submit">Log in &amp; allow access</button>
    </form>
  `));
}

function renderConsentPage(res, { client, params, user }) {
  res.status(200).send(pageShell('Allow access? — Recon', `
    <h1>Allow <strong>${escapeHtml(client.client_name || client.client_id)}</strong> to access Recon?</h1>
    <div class="who">Signed in as <strong>${escapeHtml(user.name)}</strong>. It will be able to read and update reconciliation data on your behalf.</div>
    <form method="post">
      ${hiddenAuthFields(client, params)}
      <input type="hidden" name="recon_action" value="approve">
      <button class="primary" type="submit">Allow</button>
    </form>
    <form method="post">
      ${hiddenAuthFields(client, params)}
      <input type="hidden" name="recon_action" value="deny">
      <button class="secondary" type="submit">Deny</button>
    </form>
  `));
}

function createOAuthProvider(pool) {
  const clientsStore = {
    async getClient(clientId) {
      const { rows } = await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]);
      return rows[0] ? rowToClient(rows[0]) : undefined;
    },
    async registerClient(client) {
      const clientId = crypto.randomUUID();
      const issuedAt = Math.floor(Date.now() / 1000);
      await pool.query(
        `INSERT INTO oauth_clients
           (client_id, client_secret, client_secret_expires_at, redirect_uris, client_name,
            token_endpoint_auth_method, grant_types, response_types, scope, client_id_issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          clientId,
          client.client_secret || null,
          client.client_secret_expires_at || null,
          JSON.stringify(client.redirect_uris),
          client.client_name || null,
          client.token_endpoint_auth_method || 'none',
          client.grant_types ? JSON.stringify(client.grant_types) : null,
          client.response_types ? JSON.stringify(client.response_types) : null,
          client.scope || null,
          issuedAt,
        ],
      );
      return { ...client, client_id: clientId, client_id_issued_at: issuedAt };
    },
  };

  return {
    clientsStore,

    async authorize(client, params, res) {
      const req = res.req;
      const action = req.method === 'POST' ? req.body.recon_action : undefined;

      if (action === 'deny') {
        throw new AccessDeniedError('User denied the request');
      }

      if (action === 'login') {
        const result = await attemptLogin(req);
        if (!result.ok) return renderLoginPage(res, { client, params, error: result.error });
        return issueCodeAndRedirect(pool, client, params, result.user.id, res);
      }

      if (action === 'approve') {
        if (!req.session || !req.session.userId) {
          return renderLoginPage(res, { client, params, error: 'Your session expired — please log in again.' });
        }
        return issueCodeAndRedirect(pool, client, params, req.session.userId, res);
      }

      if (req.session && req.session.userId) {
        const { rows } = await pool.query('SELECT id, name FROM users WHERE id = $1 AND active = true', [req.session.userId]);
        if (rows[0]) return renderConsentPage(res, { client, params, user: rows[0] });
      }
      return renderLoginPage(res, { client, params });
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const { rows } = await pool.query(
        'SELECT code_challenge FROM oauth_auth_codes WHERE code_hash = $1 AND client_id = $2 AND used = false AND expires_at > now()',
        [hash(authorizationCode), client.client_id],
      );
      if (!rows.length) throw new InvalidGrantError('Invalid, expired, or already-used authorization code');
      return rows[0].code_challenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode) {
      const codeHash = hash(authorizationCode);
      const { rows } = await pool.query(
        `UPDATE oauth_auth_codes SET used = true
         WHERE code_hash = $1 AND client_id = $2 AND used = false AND expires_at > now()
         RETURNING user_id, scope, resource`,
        [codeHash, client.client_id],
      );
      if (!rows.length) throw new InvalidGrantError('Invalid, expired, or already-used authorization code');
      const { user_id: userId, scope, resource } = rows[0];
      return issueTokenPair(pool, client.client_id, userId, scope, resource);
    },

    async exchangeRefreshToken(client, refreshToken) {
      const refreshHash = hash(refreshToken);
      const { rows } = await pool.query(
        `SELECT user_id, scope, revoked, expires_at FROM oauth_tokens
         WHERE token_hash = $1 AND client_id = $2 AND token_type = 'refresh'`,
        [refreshHash, client.client_id],
      );
      const row = rows[0];
      if (!row || row.revoked || (row.expires_at && row.expires_at < new Date())) {
        throw new InvalidGrantError('Invalid or revoked refresh token');
      }
      await pool.query(
        `UPDATE oauth_tokens SET revoked = true WHERE client_id = $1 AND (token_hash = $2 OR paired_token_hash = $2)`,
        [client.client_id, refreshHash],
      );
      return issueTokenPair(pool, client.client_id, row.user_id, row.scope, null);
    },

    async verifyAccessToken(token) {
      const { rows } = await pool.query(
        `SELECT ot.user_id, ot.scope, ot.expires_at, ot.revoked, u.name, u.active
         FROM oauth_tokens ot JOIN users u ON u.id = ot.user_id
         WHERE ot.token_hash = $1 AND ot.token_type = 'access'`,
        [hash(token)],
      );
      const row = rows[0];
      if (!row || row.revoked || !row.active || (row.expires_at && row.expires_at < new Date())) {
        throw new InvalidTokenError('Invalid or expired token');
      }
      return {
        token,
        clientId: String(row.user_id),
        scopes: row.scope ? row.scope.split(' ') : [],
        expiresAt: row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : undefined,
        extra: { userId: row.user_id, name: row.name },
      };
    },

    async revokeToken(client, request) {
      await pool.query(
        `UPDATE oauth_tokens SET revoked = true WHERE client_id = $1 AND (token_hash = $2 OR paired_token_hash = $2)`,
        [client.client_id, hash(request.token)],
      );
    },
  };
}

async function issueCodeAndRedirect(pool, client, params, userId, res) {
  const code = randomToken();
  await pool.query(
    `INSERT INTO oauth_auth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '${AUTH_CODE_TTL_SECONDS} seconds')`,
    [
      hash(code),
      client.client_id,
      userId,
      params.redirectUri,
      params.codeChallenge,
      params.scopes && params.scopes.length ? params.scopes.join(' ') : null,
      params.resource ? params.resource.href : null,
    ],
  );
  const redirectUrl = new URL(params.redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (params.state) redirectUrl.searchParams.set('state', params.state);
  res.redirect(302, redirectUrl.href);
}

async function issueTokenPair(pool, clientId, userId, scope, resource) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const accessHash = hash(accessToken);
  const refreshHash = hash(refreshToken);

  await pool.query(
    `INSERT INTO oauth_tokens (token_hash, token_type, client_id, user_id, scope, paired_token_hash, expires_at)
     VALUES ($1, 'access', $2, $3, $4, $5, now() + interval '${ACCESS_TOKEN_TTL_SECONDS} seconds')`,
    [accessHash, clientId, userId, scope, refreshHash],
  );
  await pool.query(
    `INSERT INTO oauth_tokens (token_hash, token_type, client_id, user_id, scope, paired_token_hash, expires_at)
     VALUES ($1, 'refresh', $2, $3, $4, $5, null)`,
    [refreshHash, clientId, userId, scope, accessHash],
  );

  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: scope || undefined,
  };
}

module.exports = { createOAuthProvider };
