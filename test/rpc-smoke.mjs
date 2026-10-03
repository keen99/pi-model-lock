#!/usr/bin/env node
// Real pinned-pi smoke: isolated agent dir (PI_CODING_AGENT_DIR sandbox),
// extension loaded via -e. Verifies load, command registration, and that
// /model-lock status answers without touching the sandbox settings file.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'model-lock-rpc-'));
const agentDir = join(dir, 'agent');
mkdirSync(join(agentDir, 'sessions'), { recursive: true });
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'zai', defaultModel: 'glm-5.3-flash' }));

const child = spawn(
  process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
  ['--mode', 'rpc', '--no-extensions', '-e', join(root, 'index.ts'), '--session-dir', join(agentDir, 'sessions')],
  { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, cwd: dir },
);
const killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000);
let out = '';
let prompted = false;
child.stdout.on('data', (d) => {
  out += d;
  if (!prompted && out.includes('"commands"') && out.includes('"model-lock"')) {
    prompted = true;
    child.stdin.write(JSON.stringify({ type: 'prompt', id: 'smoke-2', message: '/model-lock status' }) + '\n');
  } else if (prompted && out.includes('model-lock [status]')) {
    child.kill('SIGTERM');
  }
});
child.stderr.on('data', (d) => { out += d; });
child.on('exit', () => {
  clearTimeout(killTimer);
  try {
    const responseLine = out.split('\n').find((l) => l.includes('"commands"'));
    assert2(responseLine, `no commands response; raw=${out.slice(0, 3000)}`);
    const commands = JSON.parse(responseLine).data.commands;
    assert2(commands.some((c) => c.name === 'model-lock'), '/model-lock registered');
    assert2(commands.some((c) => c.name === 'model-save'), '/model-save registered');
    assert2(out.includes('model-lock [status]'), 'status command answered via notify');
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    assert2(settings.defaultModel === 'glm-5.3-flash', 'settings untouched by status');
    console.log('Pinned-pi RPC smoke PASS: load, commands, status, settings untouched.');
  } catch (e) {
    console.error('FAIL', e.message);
    process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
child.stdin.write(JSON.stringify({ type: 'get_commands', id: 'smoke-1' }) + '\n');
function assert2(cond, msg) { if (!cond) throw new Error(msg); }
