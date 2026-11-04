// Adapter registry. Every *.js file in this folder (except this one and files starting with "_")
// is a source adapter. Shared code never lists sources: adding a state = adding one adapter file
// (or, for a platform we already speak, one config entry).
//
// An adapter's default export:
//   id            string, unique, used in the DB `source` column and config/sources/<id>.json
//   name          human label
//   targets()     → [{ key, state, scope:'state'|'county', countyFips?, levels:['state','county'|'precinct'],
//                      races:['senate','governor','house'], measures:boolean, label }]
//                   one entry per thing the poller fetches; read from config, not hardcoded
//   fetch(target, ctx) → { changed:false } | { changed:true, result }
//                   ctx = { http, log, unmatched(kind, value, context) }
//                   result: the adapter result in docs/data-contract.md section 1 (election incl. optional electionKey,
//                   version, sourceUpdatedAt, turnout[], races[] with units[], methods[]). That document is the
//                   source of truth; missing values are null, never 0.
//   A target may carry `election` (a key from config/elections.json); otherwise the current election is assumed.
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));

export async function loadAdapters() {
  const files = readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('_'));
  const adapters = [];
  for (const f of files.sort()) {
    const mod = (await import(pathToFileURL(path.join(dir, f)).href)).default;
    for (const k of ['id', 'name', 'targets', 'fetch']) {
      if (!mod?.[k]) throw new Error(`Adapter ${f} is missing "${k}"`);
    }
    if (adapters.some((a) => a.id === mod.id)) throw new Error(`Duplicate adapter id "${mod.id}" (${f})`);
    adapters.push(mod);
  }
  return adapters;
}
