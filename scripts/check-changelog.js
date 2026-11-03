// Validates CHANGELOG.json, the single source of the app version. Runs before every build (and so
// before every deploy): a malformed release entry fails loudly here instead of shipping a blank
// or wrong version.
//
// Usage: node scripts/check-changelog.js [path]
// The path (or CHANGELOG_PATH) defaults to the repo's CHANGELOG.json; handy for testing a broken copy.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const override = process.argv[2] || process.env.CHANGELOG_PATH;
const file = override ? resolve(override) : new URL('../CHANGELOG.json', import.meta.url);
const fail = (msg) => {
  console.error(`\nCHANGELOG.json: ${msg}\n`);
  process.exit(1);
};

let doc;
try {
  doc = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  fail(`not valid JSON (${err.message})`);
}
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SECTIONS = ['New', 'Improved', 'Fixed', 'Removed'];
if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('must be a JSON object');
if (!Array.isArray(doc.releases) || !doc.releases.length) fail('`releases` must be a non-empty list (newest first)');

const cmp = (a, b) => {
  const x = a.match(SEMVER).slice(1).map(Number);
  const y = b.match(SEMVER).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
doc.releases.forEach((r, i) => {
  const at = `releases[${i}]${r?.version ? ` (${r.version})` : ''}`;
  if (!SEMVER.test(r?.version ?? '')) fail(`${at}: version must look like 1.2.3`);
  if (!DATE.test(r.date ?? '') || Number.isNaN(Date.parse(r.date))) fail(`${at}: date must be YYYY-MM-DD`);
  if (!r.sections || typeof r.sections !== 'object') fail(`${at}: sections is required`);
  for (const [k, items] of Object.entries(r.sections)) {
    if (!SECTIONS.includes(k)) fail(`${at}: unknown section "${k}" (use ${SECTIONS.join(', ')})`);
    if (!Array.isArray(items) || !items.length || items.some((t) => typeof t !== 'string' || !t.trim())) fail(`${at}: section "${k}" needs a list of non-empty strings`);
  }
  if (i > 0 && cmp(doc.releases[i - 1].version, r.version) <= 0) fail(`${at}: releases must be newest first (${doc.releases[i - 1].version} is listed above it)`);
  if (i > 0 && doc.releases[i - 1].date < r.date) fail(`${at}: dated after the release listed above it`);
});

const newest = doc.releases[0].version;
if (doc.next != null) {
  const n = doc.next;
  if (typeof n !== 'object' || Array.isArray(n)) fail('`next` must be an object');
  if (n.version !== undefined) {
    if (!SEMVER.test(n.version ?? '')) fail('next: version must look like 1.2.3');
    if (cmp(n.version, newest) <= 0) fail(`next: version ${n.version} must be greater than the newest release (${newest})`);
  }
  if (n.items !== undefined && (!Array.isArray(n.items) || n.items.some((t) => typeof t !== 'string' || !t.trim()))) fail('next: items must be a list of non-empty strings');
}
console.log(`CHANGELOG.json ok: version ${newest} (${doc.releases.length} release${doc.releases.length === 1 ? '' : 's'})`);
