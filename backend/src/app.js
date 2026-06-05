const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes      = require('./routes/auth');
const scoreboardRoutes = require('./routes/scoreboard');
const requireAuth     = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/auth',       authRoutes);
app.use('/api/scoreboard', requireAuth, scoreboardRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`BRIC Backend running on port ${PORT}`);
});

module.exports = app;
