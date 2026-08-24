// Adapted from /datos/forja/backend/src/routes/friends.js. openGym profiles have no email
// field, so "add by email" becomes "add by friend code" (same shape as openGym's own invite
// codes: a short random code the user shares). Display names no longer come from a local
// `users` JOIN — they're resolved from openGym's db.json via /internal/users.
const router = require('express').Router();
const pool = require('../db');
const { sessionRequired, resolveUsers } = require('../sessionBridge');
const { tierForPoints } = require('../gamerules');
const { notifyUser } = require('../push');
const { ensureStats } = require('./me');

router.use(sessionRequired);

router.post('/request', async (req, res) => {
  await ensureStats(req.userId);
  const code = String(req.body.friendCode || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Falta el código de amigo' });
  const target = await pool.query('SELECT user_id FROM user_stats WHERE friend_code=$1', [code]);
  if (!target.rows.length) return res.status(404).json({ error: 'No existe ningún usuario con ese código' });
  const friendId = target.rows[0].user_id;
  if (friendId === req.userId) return res.status(400).json({ error: 'No puedes añadirte a ti mismo' });

  try {
    await pool.query('INSERT INTO friendships (user_id, friend_id, status) VALUES ($1,$2,$3)', [req.userId, friendId, 'pending']);
  } catch (e) {
    return res.status(409).json({ error: 'Ya existe una solicitud o amistad con ese usuario' });
  }
  notifyUser(friendId, 'Nueva solicitud de amistad', `${req.userName} quiere añadirte en Forja`).catch(() => {});
  res.json({ ok: true });
});

router.get('/requests', async (req, res) => {
  const result = await pool.query(
    `SELECT f.id, f.user_id FROM friendships f WHERE f.friend_id=$1 AND f.status='pending'`,
    [req.userId]
  );
  const names = await resolveUsers(result.rows.map(r => r.user_id));
  res.json(result.rows.map(r => ({ id: r.id, displayName: names.get(r.user_id) || '(usuario desconocido)' })));
});

router.patch('/requests/:id/accept', async (req, res) => {
  const result = await pool.query(
    "UPDATE friendships SET status='accepted' WHERE id=$1 AND friend_id=$2 RETURNING *",
    [req.params.id, req.userId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
  res.json(result.rows[0]);
});

router.get('/leaderboard', async (req, res) => {
  const result = await pool.query(
    `SELECT s.user_id, s.level, s.rank_points, s.streak_days, s.share_progress
     FROM user_stats s
     WHERE s.user_id = $1
     OR s.user_id IN (
       SELECT friend_id FROM friendships WHERE user_id=$1 AND status='accepted'
       UNION
       SELECT user_id FROM friendships WHERE friend_id=$1 AND status='accepted'
     )
     ORDER BY s.rank_points DESC`,
    [req.userId]
  );
  const names = await resolveUsers(result.rows.map(r => r.user_id));
  const withRank = result.rows.map(u => ({
    id: u.user_id,
    displayName: names.get(u.user_id) || '(usuario desconocido)',
    level: u.level,
    rankPoints: u.rank_points,
    streakDays: u.streak_days,
    ...tierForPoints(u.rank_points),
    isMe: u.user_id === req.userId,
    shareProgress: u.share_progress !== false,
  }));
  res.json(withRank);
});

router.delete('/:id', async (req, res) => {
  const friendId = req.params.id;
  const result = await pool.query(
    `DELETE FROM friendships WHERE status='accepted' AND ((user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)) RETURNING id`,
    [req.userId, friendId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'No erais amigos' });
  res.json({ ok: true });
});

router.get('/:id/stats', async (req, res) => {
  const friendId = req.params.id;
  const rel = await pool.query(
    `SELECT 1 FROM friendships WHERE status='accepted' AND ((user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1))`,
    [req.userId, friendId]
  );
  if (!rel.rows.length) return res.status(403).json({ error: 'No sois amigos' });

  const statsRes = await pool.query(
    'SELECT level, rank_points, streak_days, share_progress FROM user_stats WHERE user_id=$1',
    [friendId]
  );
  const u = statsRes.rows[0];
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (u.share_progress === false) return res.status(403).json({ error: 'Este usuario no comparte su progreso' });

  const names = await resolveUsers([friendId]);
  const missionsRes = await pool.query(
    `SELECT COUNT(*) c FROM missions WHERE user_id=$1 AND status='done' AND completed_at > now() - interval '7 days'`,
    [friendId]
  );
  const rank = tierForPoints(u.rank_points);
  res.json({
    displayName: names.get(friendId) || '(usuario desconocido)',
    level: u.level,
    rankTier: rank.tier,
    rankDivision: rank.division,
    streakDays: u.streak_days,
    missionsLast7Days: Number(missionsRes.rows[0].c),
  });
});

module.exports = router;
