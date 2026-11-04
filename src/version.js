'use strict';
// Single source of truth for the app version: package.json "version" (semantic versioning).
// Build metadata comes from env vars set at build time (Docker build args / CI), falling back to git.
const { execSync } = require('child_process');
const path = require('path');
const pkg = require('../package.json');

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

const commit = (process.env.BUILD_COMMIT || gitCommit() || '').slice(0, 12) || null;

module.exports = Object.freeze({
  name: pkg.name,
  version: pkg.version,
  commit,
  buildDate: process.env.BUILD_DATE || null,
  // e.g. "1.0.0+4922d91"
  full: commit ? `${pkg.version}+${commit}` : pkg.version,
});
