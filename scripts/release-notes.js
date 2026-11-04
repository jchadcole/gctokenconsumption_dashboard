#!/usr/bin/env node
'use strict';
// Prints the CHANGELOG.md section for a version (used by the release workflow).
// Usage: node scripts/release-notes.js 1.2.3
const fs = require('fs');
const path = require('path');

const version = (process.argv[2] || require('../package.json').version).replace(/^v/, '');
const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const m = text.match(new RegExp(`^## \\[${esc}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^\\[[^\\]]+\\]:|(?![\\s\\S]))`, 'm'));
if (!m || !m[1].trim()) {
  console.error(`No CHANGELOG.md entry for ${version}`);
  process.exit(1);
}
process.stdout.write(`${m[1].trim()}\n`);
