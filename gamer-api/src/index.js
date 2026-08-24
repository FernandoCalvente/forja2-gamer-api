const express = require('express');
const { router: meRouter } = require('./routes/me');
const missionsRouter = require('./routes/missions');
const friendsRouter = require('./routes/friends');
const eventsRouter = require('./routes/events');

const PORT = +(process.env.PORT || 3100);

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/me', meRouter);
app.use('/missions', missionsRouter);
app.use('/friends', friendsRouter);
app.use('/events', eventsRouter);

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'server error' });
});

app.listen(PORT, () => console.log(`gamer-api on :${PORT}`));

require('./scheduler');
