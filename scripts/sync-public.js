#!/usr/bin/env node
// Keeps the Vercel static output dir (public/) in sync with the canonical
// frontend sources in web/public/ (what web/server.js serves locally).
// Runs as the Vercel buildCommand so a stale root public/ can never ship again.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'web', 'public');
const dest = path.join(root, 'public');

if (!fs.existsSync(src)) {
  console.error(`sync-public: source not found: ${src}`);
  process.exit(1);
}

let count = 0;
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) { fs.copyFileSync(s, d); count++; }
  }
};

copyDir(src, dest);
console.log(`sync-public: copied ${count} file(s) from web/public/ to public/`);
