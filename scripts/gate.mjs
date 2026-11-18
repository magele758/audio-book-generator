#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const liveHost = /https?:\/\/(?!(?:127\.0\.0\.1|localhost)\b)/;

function unitFiles() {
  return readdirSync(join(root, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => join('test', name));
}

function regressionStaysOffline() {
  const source = readFileSync(join(root, 'scripts', 'regression.mjs'), 'utf8');
  return !liveHost.test(source);
}

function runNode(args) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => {
      resolve({ code: code ?? 1, ms: Date.now() - started });
    });
    child.on('error', () => {
      resolve({ code: 1, ms: Date.now() - started });
    });
  });
}

function report(name, result) {
  const status = result.code === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  const seconds = (result.ms / 1000).toFixed(1);
  console.log(`  ${name.padEnd(12)} ${status}  (${seconds}s)`);
}

const unit = await runNode(['--test', ...unitFiles()]);
let regression;
if (!regressionStaysOffline()) {
  console.error('FAIL  regression source reaches a non-local host');
  regression = { code: 1, ms: 0 };
} else {
  regression = await runNode([join('scripts', 'regression.mjs')]);
}

console.log(`\n${'─'.repeat(55)}`);
report('unit', unit);
report('regression', regression);
const failed = unit.code !== 0 || regression.code !== 0;
const summary = failed ? '\x1b[31mFAILED\x1b[0m' : '\x1b[32mPASSED\x1b[0m';
console.log(`  ${summary}`);
if (failed) process.exit(1);
