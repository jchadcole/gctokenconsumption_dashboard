'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const load = (env) => execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/config')))"], {
  cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: 'pipe',
});

test('unresolvedRefs finds op:// references in the credential variables', () => {
  const { unresolvedRefs } = require('../src/config');
  assert.deepEqual(unresolvedRefs({
    GENESYS_CLIENT_ID: 'op://Work/Genesys GenesysSC12/client_id',
    GENESYS_CLIENT_SECRET: 'abc',
    GENESYS_REGION: 'mypurecloud.com',
  }), ['GENESYS_CLIENT_ID']);
  assert.deepEqual(unresolvedRefs({ GENESYS_CLIENT_ID: 'id', GENESYS_CLIENT_SECRET: 'secret' }), []);
});

test('start-up fails with a clear message when 1Password references were not resolved', () => {
  assert.throws(() => load({
    GENESYS_CLIENT_ID: 'op://Work/Genesys GenesysSC12/client_id',
    GENESYS_CLIENT_SECRET: 'op://Work/Genesys GenesysSC12/client_secret',
  }), /1Password references.*npm run start:op/s);
});

test('resolved values (as op run passes them) are used as credentials', () => {
  const cfg = JSON.parse(load({ GENESYS_CLIENT_ID: 'id', GENESYS_CLIENT_SECRET: 'secret', GENESYS_REGION: 'usw2.pure.cloud' }));
  assert.equal(cfg.clientId, 'id');
  assert.equal(cfg.mock, false);
  assert.equal(cfg.region, 'usw2.pure.cloud');
});
