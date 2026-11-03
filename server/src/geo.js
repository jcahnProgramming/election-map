// States and counties, keyed by FIPS. The names come from the same us-atlas file the map draws,
// so a county we can match is a county the map can shade.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const atlas = require('us-atlas/counties-albers-10m.json');

// USPS abbreviation ↔ state FIPS (us-atlas carries names, not abbreviations).
export const STATE_FIPS = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12',
  GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23',
  MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33',
  NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44',
  SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56',
};
const FIPS_STATE = Object.fromEntries(Object.entries(STATE_FIPS).map(([a, f]) => [f, a]));

const stateNames = new Map(atlas.objects.states.geometries.map((g) => [g.id, g.properties.name]));

export const STATES = Object.entries(STATE_FIPS)
  .map(([abbr, fips]) => ({ abbr, fips, name: stateNames.get(fips) ?? abbr }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const stateByAbbr = (abbr) => STATES.find((s) => s.abbr === String(abbr).toUpperCase()) ?? null;
export const abbrForFips = (fips) => FIPS_STATE[String(fips).slice(0, 2)] ?? null;

/**
 * Normalize a county name for matching: case, accents, punctuation, "County"/"Parish" suffixes, Saint/St.
 * "St. Louis City" and "St. Louis County" stay distinct because "city" is kept.
 */
export function normCounty(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bste\.?\b/g, 'ste')
    .replace(/[.'’`-]/g, ' ')
    .replace(/\b(county|parish|borough|census area|municipality|city and borough)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// state FIPS → Map(normalized name → { fips, name })
const countyIndex = new Map();
for (const g of atlas.objects.counties.geometries) {
  const st = g.id.slice(0, 2);
  if (!countyIndex.has(st)) countyIndex.set(st, new Map());
  countyIndex.get(st).set(normCounty(g.properties.name), { fips: g.id, name: g.properties.name });
}

/** Per-state overrides for names a source spells differently from the atlas. Extend as sources show up. */
const ALIASES = {
  // normalized source name → normalized atlas name, per state abbr
  VA: {},
  MO: { 'st louis county': 'st louis' },
};

/** @returns {{fips:string,name:string}|null} */
export function matchCounty(stateAbbr, sourceName) {
  const st = STATE_FIPS[stateAbbr];
  const idx = st && countyIndex.get(st);
  if (!idx) return null;
  let key = normCounty(sourceName);
  key = ALIASES[stateAbbr]?.[key] ?? key;
  return idx.get(key) ?? null;
}

export function countiesOf(stateAbbr) {
  const idx = countyIndex.get(STATE_FIPS[stateAbbr]);
  return idx ? [...idx.values()] : [];
}
