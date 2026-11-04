// Applies photo review decisions exported from the review page (client/dev/photos-review.html) to
// config/elections/<election>/candidates/<ST>.json:
//   approve → "reviewed": true            reject → the photo is removed (photo_url / source fields null, reviewed false,
//                                                   a note says it was rejected in review)
// Then re-runs the fairness check (photos show in a contest only when every major candidate has an approved photo),
// prints a summary per state and regenerates docs/photos-review.md.
//
// Usage: npm run photos:apply -- <decisions.json> [electionKey]
//   decisions.json = [{ "state": "CO", "candidateId": "senate:john hickenlooper", "decision": "approve" | "reject" }, …]
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { candidateId, contestFairness } from '../server/src/photo-rules.js';

const PHOTO_FIELDS = ['photo_url', 'source_type', 'source_page_url', 'license', 'credit'];

/**
 * Pure: apply decisions to { ST: doc } and report what happened.
 * @param {Record<string, {candidates:object[]}>} docs  parsed state files (not mutated)
 * @param {{state:string, candidateId:string, decision:'approve'|'reject'}[]} decisions
 * @param {{ date?: string }} [opts]
 * @returns {{ docs: Record<string, object>, summary: object[], unknown: object[], changedStates: string[] }}
 */
export function applyDecisions(docs, decisions, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const out = structuredClone(docs);
  const unknown = [];
  const counts = {};
  const changed = new Set();
  for (const d of decisions || []) {
    const st = String(d?.state ?? '').toUpperCase();
    const doc = out[st];
    const e = doc?.candidates?.find((x) => candidateId(x) === d?.candidateId);
    if (!e || !['approve', 'reject'].includes(d?.decision)) { unknown.push(d); continue; }
    counts[st] ??= { approved: 0, rejected: 0, skipped: 0 };
    if (!e.photo_url) { counts[st].skipped++; continue; } // nothing to approve or reject (already removed)
    if (d.decision === 'approve') {
      e.reviewed = true;
      counts[st].approved++;
    } else {
      for (const k of PHOTO_FIELDS) e[k] = null;
      e.reviewed = false;
      e.note = `Photo rejected in review ${date}.${e.note ? ` Earlier note: ${e.note}` : ''}`;
      counts[st].rejected++;
    }
    changed.add(st);
  }
  const summary = Object.keys(out).sort().map((st) => {
    const entries = out[st].candidates ?? [];
    const fair = contestFairness(entries);
    return {
      state: st,
      approved: counts[st]?.approved ?? 0,
      rejected: counts[st]?.rejected ?? 0,
      reviewedPhotos: entries.filter((e) => e.photo_url && e.reviewed === true).length,
      pendingPhotos: entries.filter((e) => e.photo_url && e.reviewed !== true).length,
      contests: fair.length,
      photosShow: fair.filter((c) => c.show).map((c) => c.key),
      initialsOnly: fair.filter((c) => !c.show).length,
    };
  });
  return { docs: out, summary, unknown, changedStates: [...changed].sort() };
}

/** One line per state, for the terminal. */
export function formatSummary(summary) {
  return summary.map((s) => `${s.state}: +${s.approved} approved, -${s.rejected} rejected · ${s.reviewedPhotos} reviewed, ${s.pendingPhotos} still to review · `
    + `photos will show in ${s.photosShow.length} of ${s.contests} contests${s.photosShow.length ? ` (${s.photosShow.join(', ')})` : ''}, initials only in ${s.initialsOnly}`).join('\n');
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [file, ekArg] = argv;
  if (!file) {
    console.error('Usage: npm run photos:apply -- <decisions.json> [electionKey]');
    process.exit(2);
  }
  const ek = ekArg || JSON.parse(readFileSync(path.join(root, 'config', 'elections.json'), 'utf8')).current;
  const dir = path.join(root, 'config', 'elections', ek, 'candidates');
  if (!existsSync(dir)) { console.error(`No candidate files for ${ek}`); process.exit(1); }
  let decisions = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  if (!Array.isArray(decisions)) decisions = decisions?.decisions ?? [];
  const raw = {};
  const docs = {};
  for (const f of readdirSync(dir).filter((x) => /^[A-Z]{2}\.json$/.test(x))) {
    raw[f.slice(0, 2)] = readFileSync(path.join(dir, f), 'utf8');
    docs[f.slice(0, 2)] = JSON.parse(raw[f.slice(0, 2)]);
  }
  const r = applyDecisions(docs, decisions);
  for (const st of r.changedStates) {
    writeFileSync(path.join(dir, `${st}.json`), JSON.stringify(r.docs[st], null, 2) + (raw[st].endsWith('\n') ? '\n' : ''));
  }
  console.log(`${decisions.length} decisions · ${r.changedStates.length} state files updated${r.unknown.length ? ` · ${r.unknown.length} not matched (ignored)` : ''}`);
  for (const u of r.unknown.slice(0, 10)) console.log(`  not matched: ${JSON.stringify(u)}`);
  console.log(formatSummary(r.summary));
  execFileSync(process.execPath, [path.join(root, 'scripts', 'photos-review.js'), ek], { stdio: 'inherit' });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
