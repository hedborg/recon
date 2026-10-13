const crypto = require('crypto');

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Returns { id, name } for a valid, active token, or null.
async function findUserByToken(pool, rawToken) {
  const { rows } = await pool.query(
    'SELECT id, name FROM users WHERE api_token_hash = $1 AND active = true',
    [hashToken(rawToken)],
  );
  return rows[0] || null;
}

module.exports = { hashToken, findUserByToken };
