import { spawn } from 'node:child_process';

const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const tasks = ['dev:server', 'dev:web'];
const children = tasks.map(task => spawn(packageManager, ['run', task], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
}));

let stopping = false;
const stop = (signal = 'SIGTERM') => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
};

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));

for (const child of children) {
  child.once('error', error => {
    console.error('Could not start a development process:', error);
    process.exitCode = 1;
    stop();
  });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      process.exitCode = code ?? (signal ? 1 : 0);
      stop();
    }
  });
}
