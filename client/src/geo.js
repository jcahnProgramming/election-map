import { feature } from 'topojson-client';
import { geoPath } from 'd3-geo';
import statesTopo from 'us-atlas/states-albers-10m.json';

// Pre-projected (Albers, 975x610) — no projection.
export const path = geoPath();
export const NATIONAL_VIEWBOX = '0 0 975 610';
export const stateFeatures = feature(statesTopo, statesTopo.objects.states).features;

let countiesPromise = null;
/** Lazily loads counties (separate chunk; ~800KB). Resolves to { counties, states }. */
export function loadCounties() {
  if (!countiesPromise) {
    countiesPromise = import('us-atlas/counties-albers-10m.json').then((m) => {
      const topo = m.default || m;
      return {
        counties: feature(topo, topo.objects.counties).features,
        states: feature(topo, topo.objects.states).features,
      };
    });
    countiesPromise.catch(() => { countiesPromise = null; });
  }
  return countiesPromise;
}

export function viewBoxFor(feat, padFrac = 0.04) {
  const [[x0, y0], [x1, y1]] = path.bounds(feat);
  const w = x1 - x0, h = y1 - y0;
  const pad = Math.max(w, h) * padFrac;
  return `${x0 - pad} ${y0 - pad} ${w + 2 * pad} ${h + 2 * pad}`;
}

export const FIPS_TO_ABBR = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC',
  '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT',
  '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT',
  '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY', '72': 'PR',
};
export const ABBR_TO_FIPS = Object.fromEntries(Object.entries(FIPS_TO_ABBR).map(([f, a]) => [a, f]));
