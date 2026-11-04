// NIST SP 1500-100 Election Results Common Data Format feeds (XML). First user: Ohio SOS
// (https://liveresults.ohiosos.gov/Api/v1/download?filename=VSSC1622XmlFileBlob, ~1.2 MB, ETag'd, max-age=15).
//
// The parsing lives in _nist-cdf.js (generic, V1 + V2 schema). This file only does the polling:
//   1. conditional GET of the feed (If-None-Match / If-Modified-Since); a 304 is "no change"
//   2. a content hash that ignores GeneratedDate, so a re-export with identical numbers is "no change" too
//   3. parse every contest in the feed (v0.3: nothing is filtered by office), report the source's own GeneratedDate
// Which feeds to poll is config, not code: config/sources/nistcdf.json.
import { readConfig } from '../config.js';
import { cdfVersion, fixGeneratedDate, parseCdf } from './_nist-cdf.js';

const lastVersion = new Map(); // target key → content hash

function targets() {
  const cfg = readConfig('sources/nistcdf.json', { feeds: [] });
  return cfg.feeds
    .filter((f) => f.enabled !== false)
    .map((f) => ({
      key: f.id,
      state: f.state,
      scope: 'state',
      countyFips: null,
      label: f.name,
      levels: ['state', 'county'],
      races: f.races ?? ['senate', 'governor', 'house'],
      measures: f.measures !== false,
      // Ohio's SOS feed has federal, statewide, legislative, appeals-court and state-issue contests but no county or
      // municipal ones, so a feed is not the whole ballot unless its config says so.
      allContests: f.allContests ?? false,
      feedUrl: f.feedUrl,
      url: f.url,
      date: f.date ?? null,
      hour12: !!f.generatedDate12HourClock,
    }));
}

/** Pure: XML text → contract result (minus change detection). */
export function buildResult(xml, t, { unmatched = () => {}, now = new Date() } = {}) {
  const parsed = parseCdf(xml, { state: t.state, unmatched });
  const version = cdfVersion(xml);
  return {
    election: {
      sourceKey: t.key, state: t.state, scope: 'state', countyFips: null,
      name: t.label, date: t.date ?? parsed.electionDate, url: t.url,
    },
    version,
    sourceUpdatedAt: fixGeneratedDate(parsed.generatedDate, { hour12: t.hour12, now }),
    turnout: parsed.turnout,
    races: parsed.races,
  };
}

async function fetchTarget(t, { http, unmatched }) {
  const res = await http.get(t.feedUrl, { conditional: true, timeoutMs: 60000, accept: 'application/xml,text/xml,*/*' });
  if (res.notModified && lastVersion.has(t.key)) return { changed: false, version: lastVersion.get(t.key) };
  if (!/<ElectionReport\b/.test(res.text.slice(0, 2000))) {
    throw new Error(`Not a NIST CDF ElectionReport (starts ${JSON.stringify(res.text.slice(0, 80))})`);
  }
  const version = cdfVersion(res.text);
  if (lastVersion.get(t.key) === version) return { changed: false, version };
  const result = buildResult(res.text, t, { unmatched });
  lastVersion.set(t.key, version);
  return { changed: true, version, result };
}

export default {
  id: 'nistcdf',
  name: 'NIST 1500-100 Election Results CDF feeds',
  targets,
  fetch: fetchTarget,
};
