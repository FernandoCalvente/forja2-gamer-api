// Adapted from /datos/forja/backend/src/routes/missions.js. The reward/streak/rank logic in
// complete/uncomplete is ported line-for-line against user_stats instead of users. The only
// structural change is the suggested-mission pattern detection, which now reads openGym's
// workout JSON (workoutPatterns.js) instead of Forja's exercise_logs/exercises SQL tables —
// see that file for why (no per-exercise category available server-side here).
const router = require('express').Router();
const pool = require('../db');
const { sessionRequired } = require('../sessionBridge');
const { applyXp, tierForPoints, divisionRoman } = require('../gamerules');
const { notifyUser } = require('../push');
const { ensureStats } = require('./me');
const { suggestedPatternForToday, daysSinceLastWorkout } = require('../workoutPatterns');

router.use(sessionRequired);

function madridToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}

router.get('/', async (req, res) => {
  await ensureStats(req.userId);
  const today = madridToday();

  await pool.query(
    `UPDATE missions SET status='pending', completed_at=NULL, due_date=$2
     WHERE user_id=$1 AND recurring='daily' AND due_date < $2`,
    [req.userId, today]
  );

  await pool.query(
    `DELETE FROM missions WHERE user_id=$1 AND source='suggested' AND status='pending' AND due_date < $2`,
    [req.userId, today]
  );

  const alreadyRes = await pool.query(
    `SELECT id FROM missions WHERE user_id=$1 AND source='suggested' AND due_date=$2`,
    [req.userId, today]
  );

  if (!alreadyRes.rows.length) {
    const DOW_NAMES = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
    const pattern = suggestedPatternForToday(req.userId, today);
    let created = false;
    if (pattern) {
      const dow = new Date(today + 'T12:00:00').getDay();
      await pool.query(
        `INSERT INTO missions (user_id, title, category, xp_reward, source, due_date)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.userId, `Sueles entrenar ${pattern.routineName} los ${DOW_NAMES[dow]} — ¿lo dejamos para hoy?`, 'SUGERENCIA', 35, 'suggested', today]
      );
      created = true;
    }
    if (!created) {
      const daysSince = daysSinceLastWorkout(req.userId);
      if (daysSince === null || daysSince >= 3) {
        const d = daysSince === null ? 'varios' : daysSince;
        await pool.query(
          `INSERT INTO missions (user_id, title, category, xp_reward, source, due_date)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.userId, `Llevas ${d} días sin entrenar — ¡hoy toca!`, 'SUGERENCIA', 30, 'suggested', today]
        );
      }
    }
  }

  const { date } = req.query;
  let result;
  if (date) {
    result = await pool.query('SELECT * FROM missions WHERE user_id=$1 AND due_date=$2 ORDER BY created_at', [req.userId, date]);
  } else {
    result = await pool.query(
      `SELECT * FROM missions WHERE user_id=$1 AND (status='pending' OR due_date=$2) ORDER BY due_date, created_at`,
      [req.userId, today]
    );
  }
  res.json(result.rows);
});

router.post('/', async (req, res) => {
  await ensureStats(req.userId);
  const { title, category, xpReward, dueDate, source, recurring } = req.body;
  if (!title) return res.status(400).json({ error: 'Falta el título de la misión' });
  const result = await pool.query(
    `INSERT INTO missions (user_id, title, category, xp_reward, due_date, source, recurring)
     VALUES ($1,$2,$3,$4, COALESCE($5, $8), $6, $7) RETURNING *`,
    [req.userId, title, category || null, xpReward || 50, dueDate || null, source || 'manual', recurring || null, madridToday()]
  );
  res.json(result.rows[0]);
});

router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM missions WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  res.json({ ok: true });
});

router.patch('/:id', async (req, res) => {
  const { title, category, recurring, dueDate } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (title !== undefined) { fields.push(`title=$${i++}`); values.push(title); }
  if (category !== undefined) { fields.push(`category=$${i++}`); values.push(category); }
  if (recurring !== undefined) { fields.push(`recurring=$${i++}`); values.push(recurring || null); }
  if (dueDate !== undefined) { fields.push(`due_date=$${i++}`); values.push(dueDate); }
  if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });
  values.push(req.params.id, req.userId);
  const result = await pool.query(
    `UPDATE missions SET ${fields.join(', ')} WHERE id=$${i} AND user_id=$${i + 1} RETURNING *`,
    values
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Misión no encontrada' });
  res.json(result.rows[0]);
});

router.patch('/:id/complete', async (req, res) => {
  const missionRes = await pool.query('SELECT * FROM missions WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  const mission = missionRes.rows[0];
  if (!mission) return res.status(404).json({ error: 'Misión no encontrada' });
  if (mission.status === 'done') return res.json(mission);

  await pool.query("UPDATE missions SET status='done', completed_at=now() WHERE id=$1", [mission.id]);

  const user = await ensureStats(req.userId);
  const { level, xp } = applyXp(user, mission.xp_reward);

  if (level > user.level) {
    notifyUser(req.userId, '¡Subiste de nivel! 🎉', `Ya eres nivel ${level}.`).catch(() => {});
  }

  const today = madridToday();
  let streak = user.streak_days;
  if (user.last_active_date) {
    const last = new Date(user.last_active_date);
    const diffDays = Math.round((new Date(today) - last) / 86400000);
    if (diffDays === 1) streak += 1;
    else if (diffDays > 1) streak = 1;
  } else {
    streak = 1;
  }

  const gained = Math.round(mission.xp_reward / 2);
  await pool.query(
    `UPDATE user_stats SET level=$1, xp=$2, rank_points = rank_points + $3, streak_days=$4, last_active_date=$5 WHERE user_id=$6`,
    [level, xp, gained, streak, today, req.userId]
  );

  const oldRankPoints = user.rank_points;
  const newRankPoints = oldRankPoints + gained;
  const oldRank = tierForPoints(oldRankPoints);
  const newRank = tierForPoints(newRankPoints);
  await pool.query(
    'INSERT INTO rank_history (user_id, rank_points, tier, division) VALUES ($1,$2,$3,$4)',
    [req.userId, newRankPoints, newRank.tier, newRank.division]
  );
  if (oldRank.tier !== newRank.tier || oldRank.division !== newRank.division) {
    notifyUser(req.userId, '¡Has subido de división! 🏆', `Ahora eres ${newRank.tier} ${divisionRoman(newRank.division)}.`).catch(() => {});
  }

  if (gained > 0) {
    const overtaken = await pool.query(
      `SELECT user_id FROM user_stats WHERE user_id IN (
         SELECT friend_id FROM friendships WHERE user_id=$1 AND status='accepted'
         UNION
         SELECT user_id FROM friendships WHERE friend_id=$1 AND status='accepted'
       ) AND rank_points > $2 AND rank_points <= $3`,
      [req.userId, oldRankPoints, newRankPoints]
    );
    for (const f of overtaken.rows) {
      notifyUser(f.user_id, 'Te han superado en el ranking', `${req.userName} te acaba de superar. ¡Responde con una sesión hoy!`).catch(() => {});
    }
  }

  res.json({ ...mission, status: 'done' });
});

router.patch('/:id/uncomplete', async (req, res) => {
  const missionRes = await pool.query('SELECT * FROM missions WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  const mission = missionRes.rows[0];
  if (!mission) return res.status(404).json({ error: 'Misión no encontrada' });
  if (mission.status !== 'done') return res.json(mission);

  await pool.query("UPDATE missions SET status='pending', completed_at=NULL WHERE id=$1", [mission.id]);

  const before = await ensureStats(req.userId);
  const oldRankPoints = before.rank_points;

  await pool.query(
    `UPDATE user_stats SET xp = GREATEST(0, xp - $1), rank_points = GREATEST(0, rank_points - $2) WHERE user_id=$3`,
    [mission.xp_reward, Math.round(mission.xp_reward / 2), req.userId]
  );

  const after = await pool.query('SELECT rank_points FROM user_stats WHERE user_id=$1', [req.userId]);
  const newRankPoints = after.rows[0].rank_points;
  const oldRank = tierForPoints(oldRankPoints);
  const newRank = tierForPoints(newRankPoints);
  await pool.query(
    'INSERT INTO rank_history (user_id, rank_points, tier, division) VALUES ($1,$2,$3,$4)',
    [req.userId, newRankPoints, newRank.tier, newRank.division]
  );
  if (oldRank.tier !== newRank.tier || oldRank.division !== newRank.division) {
    notifyUser(req.userId, 'Has bajado de división', `Ahora eres ${newRank.tier} ${divisionRoman(newRank.division)}.`).catch(() => {});
  }

  res.json({ ...mission, status: 'pending' });
});

module.exports = router;
