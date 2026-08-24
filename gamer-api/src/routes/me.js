// Adapted from /datos/forja/backend/src/routes/me.js. Gamification fields that used to live
// directly on Forja's `users` row now live in `user_stats`, keyed by openGym's uid — created
// lazily (upsert) the first time a signed-in user touches any gamification endpoint. Password
// change is dropped entirely: openGym auth is passkeys-only, there's no password here.
const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../db');
const { sessionRequired } = require('../sessionBridge');
const { tierForPoints, xpForNextLevel } = require('../gamerules');

router.use(sessionRequired);

async function ensureStats(userId) {
  const existing = await pool.query('SELECT * FROM user_stats WHERE user_id=$1', [userId]);
  if (existing.rows.length) return existing.rows[0];
  let code;
  do {
    code = crypto.randomBytes(4).toString('hex').toUpperCase();
  } while ((await pool.query('SELECT 1 FROM user_stats WHERE friend_code=$1', [code])).rows.length);
  const inserted = await pool.query(
    'INSERT INTO user_stats (user_id, friend_code) VALUES ($1,$2) RETURNING *',
    [userId, code]
  );
  return inserted.rows[0];
}

router.get('/', async (req, res) => {
  const u = await ensureStats(req.userId);
  const rank = tierForPoints(u.rank_points);
  res.json({
    id: req.userId,
    name: req.userName,
    isAdmin: req.isAdmin,
    level: u.level,
    xp: u.xp,
    xpToNextLevel: xpForNextLevel(u.level),
    rankPoints: u.rank_points,
    rankTier: rank.tier,
    rankDivision: rank.division,
    streakDays: u.streak_days,
    shareProgress: u.share_progress !== false,
    friendCode: u.friend_code,
  });
});

router.patch('/', async (req, res) => {
  await ensureStats(req.userId);
  const { shareProgress } = req.body;
  if (shareProgress === undefined) return res.status(400).json({ error: 'Nada que actualizar' });
  const result = await pool.query(
    'UPDATE user_stats SET share_progress=$1 WHERE user_id=$2 RETURNING share_progress',
    [!!shareProgress, req.userId]
  );
  res.json({ ok: true, shareProgress: result.rows[0].share_progress !== false });
});

router.get('/rank-history', async (req, res) => {
  await ensureStats(req.userId);
  const result = await pool.query(
    'SELECT rank_points, tier, division, created_at FROM rank_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30',
    [req.userId]
  );
  res.json(result.rows);
});

module.exports = { router, ensureStats };
