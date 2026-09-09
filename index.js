// ForestWatch prototype using NodeJS + React + Google Maps API
// Backend setup (NodeJS with Express) and frontend (React)

// === Backend: index.js ===
require('dotenv').config({ path: require('path').join(__dirname, 'client', '.env') });
const express = require('express');
const path = require('path');
const chatHandler = require('./api/chat');
const app = express();
// Use PORT 3001 for local dev so CRA dev server can run on 3000 simultaneously
const PORT = process.env.PORT || 3001;

// The chat request carries map context -- drawn geometry, active layers, the
// FMU list -- which overruns express.json()'s 100 kB default and surfaces as an
// opaque 413 in the UI. 1 MB is generous for that payload while still refusing
// anything pathological.
app.use(express.json({ limit: '1mb' }));

// Names the offender when a request is unexpectedly large. A 413 says only
// "too big"; this says which part grew, which is the thing worth knowing.
app.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object') {
    const size = (v) => JSON.stringify(v ?? null).length;
    const total = size(req.body);
    if (total > 100_000) {
      const parts = Object.entries(req.body)
        .map(([k, v]) => `${k}=${(size(v) / 1024).toFixed(1)}kB`)
        .join(' ');
      console.warn(`[chat] large request body: ${(total / 1024).toFixed(1)}kB (${parts})`);
    }
  }
  next();
});
app.use(express.static(path.join(__dirname, 'client', 'build')));

// AI chat proxy — keeps ANTHROPIC_API_KEY server-side
app.post('/api/chat', chatHandler);

app.get('/{*any}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'build', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
