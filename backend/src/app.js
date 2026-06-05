const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const scoreboardRoutes = require('./routes/scoreboard');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/scoreboard', scoreboardRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`BRIC Backend running on port ${PORT}`);
});

module.exports = app;
