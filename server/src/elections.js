// Which elections exist (config/elections.json) and which one is current. Nothing else in the server may
// assume there is only one election: every query is scoped by an election key, defaulting to `current`.
import { readConfig } from './config.js';

const FALLBACK = {
  current: '2026-general',
  elections: [{ key: '2026-general', name: '2026 General Election', date: '2026-11-03', races: 'races-2026.json' }],
};

/** @returns {{ current:string, elections:{key:string,name:string,date:string,races?:string}[] }} */
export function loadElections() {
  const cfg = readConfig('elections.json', FALLBACK);
  const elections = (cfg.elections ?? []).filter((e) => e && e.key);
  const current = cfg.current ?? elections[0]?.key ?? FALLBACK.current;
  if (!elections.some((e) => e.key === current)) elections.unshift({ key: current, name: current, date: null });
  return { current, elections };
}

export const currentElectionKey = () => loadElections().current;
