// config/ca loading (server/src/http.js loadExtraCAs) must fail soft: a bad file, an old Node without the API, or a
// rejected trust-store update is logged and skipped, never a startup failure. Verification itself is never turned off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadExtraCAs } from '../src/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const realCa = path.resolve(here, '..', '..', 'config', 'ca', 'globalsign-gcc-r46-ov-tls-ca-2025.pem');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'em-ca-'));
const fakeTls = (over = {}) => {
  const calls = [];
  return { calls, getCACertificates: () => ['ROOT-1', 'ROOT-2'], setDefaultCACertificates: (c) => calls.push(c), ...over };
};
const logger = () => {
  const warn = [];
  return { warn: (m) => warn.push(m), lines: warn };
};

test('valid intermediate added after the default roots (roots kept: verification stays on)', () => {
  const dir = tmp();
  copyFileSync(realCa, path.join(dir, 'gs.pem'));
  const t = fakeTls();
  assert.equal(loadExtraCAs(dir, { tlsApi: t, log: logger() }), 1);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].slice(0, 2), ['ROOT-1', 'ROOT-2']);
  assert.match(t.calls[0][2], /^-----BEGIN CERTIFICATE-----/);
});

test('a broken or empty .pem is logged and skipped; the good one still loads', () => {
  const dir = tmp();
  copyFileSync(realCa, path.join(dir, 'gs.pem'));
  writeFileSync(path.join(dir, 'broken.pem'), '-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----\n');
  writeFileSync(path.join(dir, 'empty.pem'), '# nothing here\n');
  const t = fakeTls();
  const log = logger();
  assert.equal(loadExtraCAs(dir, { tlsApi: t, log }), 1);
  assert.equal(log.lines.length, 2);
  assert.ok(log.lines.some((l) => /broken\.pem skipped/.test(l)));
  assert.ok(log.lines.some((l) => /empty\.pem skipped: no PEM certificate block/.test(l)));
});

test('older Node without tls.setDefaultCACertificates: logged, nothing thrown', () => {
  const dir = tmp();
  copyFileSync(realCa, path.join(dir, 'gs.pem'));
  const log = logger();
  assert.equal(loadExtraCAs(dir, { tlsApi: {}, log }), 0);
  assert.match(log.lines[0], /has no tls\.setDefaultCACertificates/);
});

test('trust-store update rejected: logged, nothing thrown', () => {
  const dir = tmp();
  copyFileSync(realCa, path.join(dir, 'gs.pem'));
  const log = logger();
  const t = fakeTls({ setDefaultCACertificates: () => { throw new Error('boom'); } });
  assert.equal(loadExtraCAs(dir, { tlsApi: t, log }), 0);
  assert.match(log.lines[0], /not added: boom/);
});

test('no config/ca folder: nothing to do', () => {
  assert.equal(loadExtraCAs(path.join(tmp(), 'missing'), { tlsApi: fakeTls(), log: logger() }), 0);
});

test('startup: http.js (imported by the server at boot) loads fine with a broken config/ca', () => {
  const cfg = tmp();
  for (const f of readdirSync(path.resolve(here, '..', '..', 'config'))) {
    if (f.endsWith('.json')) copyFileSync(path.resolve(here, '..', '..', 'config', f), path.join(cfg, f));
  }
  mkdirSync(path.join(cfg, 'ca'));
  writeFileSync(path.join(cfg, 'ca', 'bad.pem'), '-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../src/http.js', import.meta.url).href)}); console.log('imported ok');`], {
    env: { ...process.env, CONFIG_DIR: cfg },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(out, /imported ok/);
  void readFileSync;
});
