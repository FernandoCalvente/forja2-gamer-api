// Ported ~literally from /datos/forja/backend/src/gamerules.js — pure rules, no I/O,
// nothing here depends on the user_id being an integer vs openGym's string uid.

function xpForNextLevel(level) {
  return 500 + level * 350;
}

function applyXp(user, xpGained) {
  let { level, xp } = user;
  xp += xpGained;
  let nextLevelXp = xpForNextLevel(level);
  while (xp >= nextLevelXp) {
    xp -= nextLevelXp;
    level += 1;
    nextLevelXp = xpForNextLevel(level);
  }
  return { level, xp };
}

const TIERS = [
  { name: 'Hierro', min: 0 },
  { name: 'Bronce', min: 400 },
  { name: 'Plata', min: 900 },
  { name: 'Oro', min: 1500 },
  { name: 'Platino', min: 2200 },
  { name: 'Diamante', min: 3000 },
  { name: 'Maestro', min: 4000 },
];

function tierForPoints(points) {
  let current = TIERS[0];
  for (const t of TIERS) {
    if (points >= t.min) current = t;
  }
  const idx = TIERS.indexOf(current);
  const next = TIERS[idx + 1];
  if (!next) return { tier: current.name, division: null };
  const span = next.min - current.min;
  const progress = (points - current.min) / span;
  const division = 4 - Math.min(3, Math.floor(progress * 4));
  return { tier: current.name, division };
}

function divisionRoman(division) {
  if (!division) return '';
  const arr = ['IV', 'III', 'II', 'I'];
  return arr[4 - division];
}

module.exports = { xpForNextLevel, applyXp, tierForPoints, divisionRoman, TIERS };
