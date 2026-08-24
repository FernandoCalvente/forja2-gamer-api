// Adapted from /datos/forja/backend/src/routes/events.js — logic ported ~literally, only
// `adminRequired` (Forja's Postgres-backed middleware) is replaced by req.isAdmin, which
// sessionBridge already gets from openGym's own admin flag (user.admin / ADMIN_UIDS).
const router = require('express').Router();
const pool = require('../db');
const { sessionRequired } = require('../sessionBridge');
const { notifyAllUsers } = require('../push');

router.use(sessionRequired);

function adminRequired(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Solo administradores' });
  next();
}

function toDateStr(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

router.get('/', async (req, res) => {
  const result = await pool.query(
    `SELECT e.*,
       (SELECT COUNT(*) FROM event_participants WHERE event_id=e.id) AS participant_count,
       (SELECT row_to_json(p) FROM (
          SELECT short_day, long_day FROM event_participants WHERE event_id=e.id AND user_id=$1
        ) p) AS my_participation
     FROM events e ORDER BY e.start_date`,
    [req.userId]
  );
  res.json(result.rows);
});

router.get('/:id', async (req, res) => {
  const eventRes = await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id]);
  if (!eventRes.rows.length) return res.status(404).json({ error: 'Evento no encontrado' });
  const partRes = await pool.query(
    'SELECT short_day, long_day FROM event_participants WHERE event_id=$1 AND user_id=$2',
    [req.params.id, req.userId]
  );
  res.json({ ...eventRes.rows[0], myParticipation: partRes.rows[0] || null });
});

async function generateMissionsForParticipant(eventId, userId, shortDay, longDay) {
  const eventRes = await pool.query('SELECT * FROM events WHERE id=$1', [eventId]);
  const event = eventRes.rows[0];
  const startDateStr = toDateStr(event.start_date);
  const sessions = await pool.query('SELECT * FROM event_sessions WHERE event_id=$1', [eventId]);

  await pool.query(`DELETE FROM missions WHERE event_id=$1 AND user_id=$2 AND status='pending'`, [eventId, userId]);

  for (const s of sessions.rows) {
    let dueDate;
    if (s.day_role === 'fixed') {
      dueDate = toDateStr(s.fixed_date);
    } else {
      const dow = s.day_role === 'short' ? shortDay : longDay;
      dueDate = addDays(startDateStr, (s.week_number - 1) * 7 + Number(dow));
    }
    const exists = await pool.query('SELECT id FROM missions WHERE event_session_id=$1 AND user_id=$2', [s.id, userId]);
    if (exists.rows.length) continue;
    await pool.query(
      `INSERT INTO missions (user_id, title, category, xp_reward, due_date, source, event_id, event_session_id)
       VALUES ($1,$2,$3,$4,$5,'event',$6,$7)`,
      [userId, s.title, s.category, s.xp_reward, dueDate, eventId, s.id]
    );
  }
}

router.post('/:id/join', async (req, res) => {
  const { shortDay, longDay } = req.body;
  if (shortDay === undefined || longDay === undefined) return res.status(400).json({ error: 'Faltan los días de la semana' });
  await pool.query(
    `INSERT INTO event_participants (event_id, user_id, short_day, long_day)
     VALUES ($1,$2,$3,$4) ON CONFLICT (event_id, user_id) DO UPDATE SET short_day=$3, long_day=$4`,
    [req.params.id, req.userId, shortDay, longDay]
  );
  await generateMissionsForParticipant(req.params.id, req.userId, shortDay, longDay);
  res.json({ ok: true });
});

router.patch('/:id/participation', async (req, res) => {
  const { shortDay, longDay } = req.body;
  const existing = await pool.query('SELECT id FROM event_participants WHERE event_id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (!existing.rows.length) return res.status(404).json({ error: 'No estás en este evento' });
  await pool.query(
    'UPDATE event_participants SET short_day=$1, long_day=$2 WHERE event_id=$3 AND user_id=$4',
    [shortDay, longDay, req.params.id, req.userId]
  );
  await generateMissionsForParticipant(req.params.id, req.userId, shortDay, longDay);
  res.json({ ok: true });
});

router.delete('/:id/join', async (req, res) => {
  await pool.query('DELETE FROM event_participants WHERE event_id=$1 AND user_id=$2', [req.params.id, req.userId]);
  await pool.query(`DELETE FROM missions WHERE event_id=$1 AND user_id=$2 AND status='pending'`, [req.params.id, req.userId]);
  res.json({ ok: true });
});

router.post('/', adminRequired, async (req, res) => {
  const { name, description, startDate, sessions } = req.body;
  if (!name || !startDate || !Array.isArray(sessions)) return res.status(400).json({ error: 'Faltan datos del evento' });
  const eventRes = await pool.query(
    'INSERT INTO events (name, description, start_date, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
    [name, description || null, startDate, req.userId]
  );
  const event = eventRes.rows[0];
  let sortOrder = 0;
  for (const s of sessions) {
    await pool.query(
      `INSERT INTO event_sessions (event_id, week_number, day_role, fixed_date, title, xp_reward, category, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [event.id, s.weekNumber || null, s.dayRole, s.fixedDate || null, s.title, s.xpReward || 50, s.category || 'GENERAL', sortOrder++]
    );
  }
  notifyAllUsers('Nuevo evento 📅', `${name} ya está disponible en Forja. Únete desde Red.`).catch(() => {});
  res.json(event);
});

module.exports = router;
