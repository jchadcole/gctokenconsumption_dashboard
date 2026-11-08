'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const pkg = require('../package.json');
const version = require('../src/version');

test('package.json version is valid semver', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.equal(version.version, pkg.version);
  assert.ok(version.full.startsWith(pkg.version));
});

test('CHANGELOG.md has release notes for the current version', () => {
  const notes = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'release-notes.js'), pkg.version]).toString();
  assert.ok(notes.trim().length > 0);
});
