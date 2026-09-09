const express = require('express');
const bcrypt  = require('bcryptjs');
const pool    = require('../db');

const router = express.Router();

const FAILURE_LIMIT = 5;
const LOCKOUT_MS    = 15 * 60 * 1000;
const failureLog    = new Map();

function rateLimitKey(req) {
  return `${req.ip}:${String(req.body.name || '').toLowerCase()}`;
}

function isLockedOut(key) {
  const entry = failureLog.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstFailureAt > LOCKOUT_MS) { failureLog.delete(key); return false; }
  return entry.count >= FAILURE_LIMIT;
}

function recordFailure(key) {
  const entry = failureLog.get(key);
  if (!entry || Date.now() - entry.firstFailureAt > LOCKOUT_MS) {
    failureLog.set(key, { count: 1, firstFailureAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

router.post('/login', async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'name and password are required' });

  const key = rateLimitKey(req);
  if (isLockedOut(key)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });

  try {
    const { rows } = await pool.query(
      'SELECT id, name, password_hash, active FROM users WHERE lower(name) = lower($1)',
      [name],
    );
    const user = rows[0];

    if (!user || !user.active || !user.password_hash) {
      recordFailure(key);
      return res.status(401).json({ error: 'Invalid name or password' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      recordFailure(key);
      return res.status(401).json({ error: 'Invalid name or password' });
    }

    failureLog.delete(key);
    req.session.regenerate((err) => {
      if (err) { console.error(err); return res.status(500).json({ error: 'Login failed' }); }
      req.session.userId = user.id;
      res.json({ id: user.id, name: user.name });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.status(204).end();
  req.session.destroy(() => res.status(204).end());
});

router.get('/session', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'not logged in' });
  const { rows } = await pool.query(
    'SELECT id, name FROM users WHERE id = $1 AND active = true',
    [req.session.userId],
  );
  if (!rows.length) return res.status(401).json({ error: 'not logged in' });
  res.json(rows[0]);
});

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Login required' });
  next();
}

module.exports = { router, requireAuth };
