// Replaces Forja's push.js (which called web-push/VAPID directly against its own
// push_subscriptions table). openGym already owns push subscriptions and VAPID keys —
// this just delegates to its /internal/push instead of running a second push stack.
const OPENGYM_INTERNAL_URL = process.env.OPENGYM_INTERNAL_URL || 'http://api:3000';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';

async function post(body) {
  const r = await fetch(`${OPENGYM_INTERNAL_URL}/internal/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`push failed: ${r.status}`);
}

async function notifyUser(userId, title, body) {
  await post({ userId, title, body });
}

async function notifyAllUsers(title, body) {
  await post({ all: true, title, body });
}

module.exports = { notifyUser, notifyAllUsers };
