#!/usr/bin/env node
'use strict';
// Runs from the npm "version" lifecycle hook (npm run release:patch|minor|major).
// Moves the "## [Unreleased]" notes in CHANGELOG.md under a new "## [x.y.z] - YYYY-MM-DD" heading
// and refuses to release when there are no notes.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'CHANGELOG.md');
const version = process.env.npm_package_version || require('../package.json').version;
const repo = 'https://github.com/jchadcole/gctokenconsumption_dashboard';
const today = new Date().toISOString().slice(0, 10);

const text = fs.readFileSync(file, 'utf8');
const m = text.match(/^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|^\[[^\]]+\]:|(?![\s\S]))/m);
if (!m) {
  console.error('CHANGELOG.md has no "## [Unreleased]" section.');
  process.exit(1);
}
const notes = m[1].trim();
if (!notes) {
  console.error('CHANGELOG.md "## [Unreleased]" is empty. Add release notes before bumping the version.');
  process.exit(1);
}
if (new RegExp(`## \\[${version.replace(/\./g, '\\.')}\\]`).test(text)) {
  console.error(`CHANGELOG.md already has a section for ${version}.`);
  process.exit(1);
}

const prev = (text.match(/## \[(\d+\.\d+\.\d+[^\]]*)\]/) || [])[1];
let out = text.replace(m[0], `## [Unreleased]\n\n## [${version}] - ${today}\n\n${notes}\n\n`);

// Keep the compare links at the bottom up to date.
out = out.replace(/^\[Unreleased\]:.*$/m, `[Unreleased]: ${repo}/compare/v${version}...HEAD`);
const link = prev ? `[${version}]: ${repo}/compare/v${prev}...v${version}` : `[${version}]: ${repo}/releases/tag/v${version}`;
out = out.replace(/^(\[Unreleased\]:.*)$/m, `$1\n${link}`);

fs.writeFileSync(file, out);
console.log(`CHANGELOG.md: released ${version}`);
