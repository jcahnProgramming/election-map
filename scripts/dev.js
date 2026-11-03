// Cross-platform dev launcher: runs the API server (watch mode) and the Vite dev server together,
// each line prefixed with where it came from. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const procs = [
  ['server', ['--prefix', 'server', 'run', 'dev']],
  ['client', ['--prefix', 'client', 'run', 'dev']],
].map(([name, args]) => {
  const child = spawn(npm, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join('\n');
  child.stdout.on('data', (d) => console.log(prefix(d)));
  child.stderr.on('data', (d) => console.error(prefix(d)));
  child.on('exit', (code) => console.log(`[${name}] exited with code ${code}`));
  return child;
});

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
