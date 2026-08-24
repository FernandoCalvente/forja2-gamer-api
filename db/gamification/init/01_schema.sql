-- Gamification schema for Forja, layered on top of openGym.
-- Adapted from /datos/forja/db/init/01_schema.sql (the real production schema, reconstructed
-- from a backup dump since that file was stale). Key differences:
--   * No `users` table here — real users live in openGym's db.json, authenticated via
--     passkeys. `user_id` is openGym's uid (TEXT, base64url), not a Postgres-owned serial int,
--     so there is no FK from these tables to a local `users` row. Existence is checked at the
--     application layer against openGym's /internal/whoami and /internal/users.
--   * `user_stats` replaces the gamification columns that used to live directly on `users.*`
--     (level, xp, rank_points, streak_days, last_active_date, share_progress) — created lazily
--     on first touch by gamer-api's GET /me. Also carries `friend_code`, the "add by code"
--     mechanism replacing Forja's add-by-email (openGym profiles have no email field).
--   * `push_subscriptions` is intentionally NOT duplicated here — openGym already owns push
--     subscriptions in its own db.json; gamer-api sends through openGym's `/internal/push`.

CREATE TABLE user_stats (
  user_id TEXT PRIMARY KEY,
  level INT NOT NULL DEFAULT 1,
  xp INT NOT NULL DEFAULT 0,
  rank_points INT NOT NULL DEFAULT 0,
  streak_days INT NOT NULL DEFAULT 0,
  last_active_date DATE,
  share_progress BOOLEAN NOT NULL DEFAULT true,
  friend_code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- events/event_sessions must exist before `missions` so its FKs can reference them.
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  start_date DATE NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE event_sessions (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  week_number INT,
  day_role TEXT NOT NULL,
  fixed_date DATE,
  title TEXT NOT NULL,
  xp_reward INT NOT NULL DEFAULT 50,
  category TEXT NOT NULL DEFAULT 'GENERAL',
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE event_participants (
  event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  short_day INT NOT NULL,
  long_day INT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE missions (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  xp_reward INT NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'manual',
  due_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  recurring TEXT,
  event_id INT REFERENCES events(id) ON DELETE SET NULL,
  event_session_id INT REFERENCES event_sessions(id) ON DELETE SET NULL
);

CREATE TABLE friendships (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, friend_id)
);

CREATE TABLE rank_history (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  rank_points INT NOT NULL,
  tier TEXT NOT NULL,
  division INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scheduler_runs (
  job_name TEXT PRIMARY KEY,
  last_run_key TEXT
);

CREATE TABLE motivational_quotes (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_missions_user_due ON missions(user_id, due_date);
CREATE INDEX idx_missions_event ON missions(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_friendships_user ON friendships(user_id);
CREATE INDEX idx_friendships_friend ON friendships(friend_id);
CREATE INDEX idx_rank_history_user ON rank_history(user_id, created_at DESC);

-- Seed a starter bank of motivational quotes so checkMotivationalQuote has something to
-- rotate through from day one (Forja's production bank was populated by hand over time via
-- the admin panel — this is just enough to not broadcast nothing).
INSERT INTO motivational_quotes (text) VALUES
  ('La constancia le gana al talento cuando el talento no es constante.'),
  ('No tienes que ser extraordinario para empezar, pero tienes que empezar para ser extraordinario.'),
  ('El cuerpo logra lo que la mente cree.'),
  ('Un poco de progreso cada día suma un gran cambio.'),
  ('La disciplina es elegir entre lo que quieres ahora y lo que quieres de verdad.');
