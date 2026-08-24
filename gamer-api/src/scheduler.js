// Ported from /datos/forja/backend/src/scheduler.js — same shape: hourly setInterval + exact-
// hour guard + scheduler_runs idempotency table, all against Europe/Madrid time. Adaptations:
//   * `users` -> `user_stats` (only users who've touched gamification have a row, which is
//     the right set to process here anyway).
//   * checkWeeklySummary's "series registradas" (from exercise_logs) becomes "workouts
//     logged" from openGym's JSON via workoutPatterns.workoutsInLastDays.
const pool = require('./db');
const { notifyUser, notifyAllUsers } = require('./push');
const { tierForPoints, divisionRoman } = require('./gamerules');
const { workoutsInLastDays } = require('./workoutPatterns');

async function shouldRun(jobName) {
  const madridNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const dateStr = madridNow.toLocaleDateString('en-CA');
  const slot = `${dateStr}-${madridNow.getHours()}`;
  const result = await pool.query(
    `INSERT INTO scheduler_runs (job_name, last_run_key) VALUES ($1,$2)
     ON CONFLICT (job_name) DO UPDATE SET last_run_key=$2
     WHERE scheduler_runs.last_run_key IS DISTINCT FROM $2
     RETURNING job_name`,
    [jobName, slot]
  );
  return result.rows.length > 0;
}

async function checkStreakRisk() {
  try {
    const madridNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    if (madridNow.getHours() !== 20) return;
    if (!(await shouldRun('streakRisk'))) return;

    const today = madridNow.toLocaleDateString('en-CA');
    const result = await pool.query(
      `SELECT user_id, streak_days FROM user_stats WHERE streak_days > 0 AND (last_active_date IS NULL OR last_active_date < $1)`,
      [today]
    );
    for (const u of result.rows) {
      await notifyUser(u.user_id, 'Tu racha está en riesgo 🔥', `Llevas ${u.streak_days} días seguidos. Completa algo hoy antes de perderla.`).catch(() => {});
    }
  } catch (e) {
    console.error('Error en checkStreakRisk', e);
  }
}
setInterval(checkStreakRisk, 60 * 60 * 1000);
checkStreakRisk();

async function checkWeeklySummary() {
  try {
    const madridNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    if (madridNow.getDay() !== 0 || madridNow.getHours() !== 19) return;
    if (!(await shouldRun('weeklySummary'))) return;

    const users = await pool.query('SELECT user_id FROM user_stats');
    for (const u of users.rows) {
      const missionsRes = await pool.query(
        `SELECT COUNT(*) c, COALESCE(SUM(xp_reward),0) xp FROM missions WHERE user_id=$1 AND status='done' AND completed_at > now() - interval '7 days'`,
        [u.user_id]
      );
      const workoutCount = workoutsInLastDays(u.user_id, 7);
      const m = missionsRes.rows[0];
      if (Number(m.c) === 0 && workoutCount === 0) continue;
      await notifyUser(u.user_id, 'Resumen semanal 📊', `Esta semana: ${m.c} misiones completadas, ${m.xp} XP ganado, ${workoutCount} entrenos registrados.`).catch(() => {});
    }
  } catch (e) {
    console.error('Error en checkWeeklySummary', e);
  }
}
setInterval(checkWeeklySummary, 60 * 60 * 1000);
checkWeeklySummary();

async function checkRankDecay() {
  try {
    const madridNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    if (madridNow.getDay() !== 1 || madridNow.getHours() !== 10) return;
    if (!(await shouldRun('rankDecay'))) return;

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const result = await pool.query(
      `SELECT user_id, rank_points FROM user_stats WHERE rank_points > 0 AND (last_active_date IS NULL OR last_active_date < $1)`,
      [sevenDaysAgo]
    );
    const DECAY = 50;
    for (const u of result.rows) {
      const oldRank = tierForPoints(u.rank_points);
      const newPoints = Math.max(0, u.rank_points - DECAY);
      const newRank = tierForPoints(newPoints);
      await pool.query('UPDATE user_stats SET rank_points=$1 WHERE user_id=$2', [newPoints, u.user_id]);
      await pool.query('INSERT INTO rank_history (user_id, rank_points, tier, division) VALUES ($1,$2,$3,$4)', [u.user_id, newPoints, newRank.tier, newRank.division]);
      if (oldRank.tier !== newRank.tier || oldRank.division !== newRank.division) {
        await notifyUser(u.user_id, 'Has bajado de división 📉', `Llevas más de una semana inactivo. Ahora eres ${newRank.tier} ${divisionRoman(newRank.division)}.`).catch(() => {});
      }
    }
  } catch (e) {
    console.error('Error en checkRankDecay', e);
  }
}
setInterval(checkRankDecay, 60 * 60 * 1000);
checkRankDecay();

async function checkTodayReminders() {
  try {
    const madridNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    if (madridNow.getHours() !== 9) return;
    if (!(await shouldRun('todayReminders'))) return;

    const result = await pool.query(
      `SELECT user_id, array_agg(title) AS titles FROM missions WHERE status='pending' AND due_date = (now() AT TIME ZONE 'Europe/Madrid')::date GROUP BY user_id`
    );
    for (const row of result.rows) {
      const list = row.titles.slice(0, 3).join(' · ');
      const extra = row.titles.length > 3 ? ` (+${row.titles.length - 3} más)` : '';
      await notifyUser(row.user_id, 'Hoy toca 📋', `${list}${extra}`).catch(() => {});
    }
  } catch (e) {
    console.error('Error en checkTodayReminders', e);
  }
}
setInterval(checkTodayReminders, 60 * 60 * 1000);
checkTodayReminders();

async function checkMotivationalQuote() {
  try {
    const madridNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const hour = madridNow.getHours();
    if (hour !== 8 && hour !== 18) return;
    if (!(await shouldRun('motivationalQuote'))) return;

    const result = await pool.query('SELECT id, text FROM motivational_quotes ORDER BY last_sent_at ASC NULLS FIRST LIMIT 1');
    if (!result.rows.length) return;
    const quote = result.rows[0];
    await pool.query('UPDATE motivational_quotes SET last_sent_at=now() WHERE id=$1', [quote.id]);
    await notifyAllUsers('💬 Forja', quote.text);
  } catch (e) {
    console.error('Error en checkMotivationalQuote', e);
  }
}
setInterval(checkMotivationalQuote, 60 * 60 * 1000);
checkMotivationalQuote();

async function checkMissedEventSessions() {
  try {
    const madridNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    if (madridNow.getHours() !== 21) return;
    if (!(await shouldRun('missedEventSessions'))) return;

    const today = madridNow.toLocaleDateString('en-CA');
    const result = await pool.query(
      `SELECT user_id, title FROM missions WHERE event_id IS NOT NULL AND status='pending' AND due_date = $1`,
      [today]
    );
    for (const row of result.rows) {
      await notifyUser(row.user_id, 'Te has saltado una sesión 🏃', `"${row.title}" sigue pendiente en tu calendario. Muévela si hace falta, no pasa nada.`).catch(() => {});
    }
  } catch (e) {
    console.error('Error en checkMissedEventSessions', e);
  }
}
setInterval(checkMissedEventSessions, 60 * 60 * 1000);
checkMissedEventSessions();

module.exports = {
  checkStreakRisk, checkWeeklySummary, checkRankDecay,
  checkTodayReminders, checkMotivationalQuote, checkMissedEventSessions,
};
