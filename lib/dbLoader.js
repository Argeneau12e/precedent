// lib/dbLoader.js
// Single entry point for reading scenarioDB.json, so the on-disk shape can
// never be half-migrated. The file is now `{ builtAt, scenarios }`; a legacy
// flat array is still accepted (and reports no build time) so an un-rebuilt DB
// degrades explicitly rather than crashing the server.
const fs = require('fs');
const path = require('path');

function loadScenarioDB(file = path.join(__dirname, '..', 'scenarioDB.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw)) {
    return { scenarios: raw, builtAt: null, legacyShape: true };
  }
  if (!raw || !Array.isArray(raw.scenarios)) {
    throw new Error('scenarioDB.json is neither an array nor { builtAt, scenarios }');
  }
  return { scenarios: raw.scenarios, builtAt: raw.builtAt || null, legacyShape: false };
}

module.exports = { loadScenarioDB };