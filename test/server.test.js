'use strict';
process.env.GENESYS_MOCK = '1';
const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/server');

test('refresh=1 re-fetches usage instead of serving the cache', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const q = '/api/usage?start=2026-11-01&end=2026-11-03';
    const first = await (await fetch(base + q)).json();
    const cached = await (await fetch(base + q)).json();
    assert.equal(cached.dataFetchedAt, first.dataFetchedAt);
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await (await fetch(`${base}${q}&refresh=1`)).json();
    assert.ok(fresh.dataFetchedAt > first.dataFetchedAt);
    assert.equal(fresh.summary.totals.all.tokens, first.summary.totals.all.tokens);
  } finally {
    server.close();
  }
});

test('the tz parameter picks the time zone days are bucketed in, and bad values fall back', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await (await fetch(`${base}/api/usage?start=2026-11-01&end=2026-11-03&tz=America/Chicago`)).json();
    assert.equal(ok.query.tz, 'America/Chicago');
    const bad = await (await fetch(`${base}/api/usage?start=2026-11-01&end=2026-11-03&tz=Not/AZone`)).json();
    assert.notEqual(bad.query.tz, 'Not/AZone');
  } finally {
    server.close();
  }
});
