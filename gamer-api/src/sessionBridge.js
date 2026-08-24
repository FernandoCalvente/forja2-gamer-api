// Replaces Forja's JWT-based authRequired (middleware/auth.js): instead of verifying a
// signed token locally, forwards the browser's session cookie to openGym's own
// /internal/whoami and trusts its answer. req.userId ends up holding openGym's uid
// (a string), which is what every route below uses as the FK into the gamification tables.
const OPENGYM_INTERNAL_URL = process.env.OPENGYM_INTERNAL_URL || 'http://api:3000';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';

async function whoami(cookieHeader) {
  const r = await fetch(`${OPENGYM_INTERNAL_URL}/internal/whoami`, {
    headers: { cookie: cookieHeader || '', 'x-internal-secret': INTERNAL_SECRET },
  });
  if (!r.ok) return null;
  return r.json();
}

async function sessionRequired(req, res, next) {
  try {
    const user = await whoami(req.headers.cookie);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    req.userId = user.id;
    req.userName = user.name;
    req.isAdmin = user.admin === true;
    next();
  } catch (e) {
    console.error('sessionBridge: openGym unreachable', e.message);
    res.status(502).json({ error: 'No se pudo verificar la sesión' });
  }
}

// Resolves uid -> display name for users who only exist in openGym's db.json (no local
// `users` table here to JOIN against, unlike Forja's original friends.js/missions.js).
async function resolveUsers(ids) {
  if (!ids.length) return new Map();
  const r = await fetch(`${OPENGYM_INTERNAL_URL}/internal/users?ids=${encodeURIComponent(ids.join(','))}`, {
    headers: { 'x-internal-secret': INTERNAL_SECRET },
  });
  if (!r.ok) return new Map();
  const { users } = await r.json();
  return new Map(users.map(u => [u.id, u.name]));
}

module.exports = { sessionRequired, whoami, resolveUsers };
