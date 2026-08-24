// Replaces the SQL pattern-detection block in Forja's missions.js (which queried
// exercise_logs/exercises — tables that don't exist here). Reads openGym's own
// state-<uid>.json directly off the shared data volume, mounted read-only: gamer-api never
// writes to openGym's JSON store, only openGym's own server.js does (see workoutPatterns.js
// vs server.js's atomicWrite — two writers on the same file with no locking would risk
// corruption, so this stays read-only by design).
//
// Adaptation note: Forja's original detected "category most trained on this weekday"
// (e.g. "Pierna") by joining exercise_logs -> exercises.category. openGym's state file has
// no per-exercise category readily available server-side (that lives in the 1300+ exercise
// dataset bundled with the frontend). Using the workout's *routine name* instead ("Empuje",
// "Pierna A"...) captures the same "you usually train X on this day" signal without needing
// to ship/parse the exercise library server-side too.
const fs = require('fs');
const path = require('path');

const DATA = process.env.DATA_DIR || '/data';
const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');

function readState(uid) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8'));
  } catch {
    return null;
  }
}

// Routine usually trained on this weekday over the last 60 days, if seen >=2 times and not
// already logged today. Returns { routineName } or null.
function suggestedPatternForToday(uid, todayISO) {
  const S = readState(uid);
  if (!S || !Array.isArray(S.workouts) || !S.workouts.length) return null;

  const today = new Date(todayISO + 'T12:00:00');
  const todayDow = today.getDay();
  const cutoff = Date.now() - 60 * 86400000;

  const alreadyToday = S.workouts.some(w => w.d === todayISO);
  if (alreadyToday) return null;

  const counts = new Map(); // routineId -> count
  for (const w of S.workouts) {
    const wd = new Date(w.d + 'T12:00:00');
    if (wd.getTime() < cutoff) continue;
    if (wd.getDay() !== todayDow) continue;
    if (!w.routine) continue;
    counts.set(w.routine, (counts.get(w.routine) || 0) + 1);
  }
  if (!counts.size) return null;

  let bestId = null, bestCount = 0;
  for (const [id, c] of counts) if (c > bestCount) { bestId = id; bestCount = c; }
  if (bestCount < 2) return null;

  const routine = (S.routines || []).find(r => r.id === bestId);
  if (!routine) return null;
  return { routineName: routine.name, emoji: routine.emoji || '🏋️' };
}

// Days since the last logged workout, or null if the user has never logged one.
function daysSinceLastWorkout(uid) {
  const S = readState(uid);
  if (!S || !Array.isArray(S.workouts) || !S.workouts.length) return null;
  const last = S.workouts.reduce((max, w) => (w.d > max ? w.d : max), S.workouts[0].d);
  const diffMs = Date.now() - new Date(last + 'T12:00:00').getTime();
  return Math.floor(diffMs / 86400000);
}

// Number of workouts logged in the last N days — used by the weekly-summary job in place of
// Forja's `COUNT(*) FROM exercise_logs ... last 7 days`.
function workoutsInLastDays(uid, days) {
  const S = readState(uid);
  if (!S || !Array.isArray(S.workouts)) return 0;
  const cutoff = Date.now() - days * 86400000;
  return S.workouts.filter(w => new Date(w.d + 'T12:00:00').getTime() >= cutoff).length;
}

module.exports = { suggestedPatternForToday, daysSinceLastWorkout, workoutsInLastDays, readState };
