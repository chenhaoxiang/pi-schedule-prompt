#!/usr/bin/env node
// Run explicitly against a fixed installed package + real native CLI, with isolated synthetic resources.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const root = process.env.PI_SCHEDULE_PACKAGE_ROOT;
const cli = process.env.PI_SCHEDULE_REAL_CLI;
const ai = process.env.PI_SCHEDULE_AI_ENTRY;
if (!root || !cli || !ai) throw new Error('Set fixed package root, real native CLI and host AI entry');
const base = path.resolve('tmp/installed-native-cli'); fs.mkdirSync(base, { recursive: true });
const cwd = fs.mkdtempSync(path.join(base, 'case-')); const agentDir = path.join(cwd, 'agent');
fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: [], compaction: { enabled: false }, retry: { enabled: false } }), { mode: 0o600 });
fs.writeFileSync(path.join(agentDir, 'extensions/faux.ts'), `import {fauxProvider,fauxAssistantMessage} from ${JSON.stringify(ai)};export default pi=>{const faux=fauxProvider({provider:'fixed-cli-fixture',models:[{id:'fixture'}]});faux.setResponses([fauxAssistantMessage('FIXED_NATIVE_CLI_OK')]);pi.registerProvider(faux.provider);};`);
const stateDir = path.join(cwd, 'state'); fs.mkdirSync(stateDir, { mode: 0o700 });
let port;
for (let attempt = 0; attempt < 20; attempt++) {
  const selected = randomInt(49152, 65536); const server = net.createServer();
  const bound = await new Promise((resolve, reject) => { server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error)); server.listen(selected, '127.0.0.1', () => resolve(true)); });
  if (bound) { await new Promise(resolve => server.close(resolve)); port = selected; break; }
}
if (!port) throw new Error('No free selected fixture port after20 attempts');
const receipt = JSON.parse(fs.readFileSync(path.join(root, '.install-receipt.json'), 'utf8'));
const config = { version: 1, cwd, piCli: cli, piCliSha256: createHash('sha256').update(fs.readFileSync(cli)).digest('hex'), packageRoot: root, sourceCommit: receipt.sourceSha, sessionId: 'fixed-native-cli-fixture', model: 'fixed-cli-fixture/fixture', thinkingLevel: 'off', stateDir, controlPort: port };
const file = path.join(cwd, 'host.json'); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
const { CronStorage } = await import(pathToFileURL(path.join(root, 'dist/storage.js')).href);
const storage = new CronStorage(cwd);
storage.addJob({ id: 'cli', name: 'cli', type: 'once', schedule: new Date(Date.now() + 3000).toISOString(), prompt: 'Synthetic fixed native CLI acceptance', enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: config.sessionId, durable: true, catchUp: 'latest', maxRuns: 1, expiresAt: new Date(Date.now() + 90000).toISOString() });
const host = path.join(root, 'scripts/supervisor.mjs');
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: path.join(cwd, 'home') };
const child = spawn(process.execPath, [host, 'run', file], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
const until = async predicate => {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Native fixture host exited: ' + stderr + '; state=' + fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8'));
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Native fixed fixture deadline; no completion inferred');
};
try {
  await until(() => fs.existsSync(path.join(stateDir, 'status.json')) && JSON.parse(fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8')).ready);
  await until(() => storage.getJob('cli')?.notice?.state === 'accepted');
  assert.equal(storage.getJob('cli').claim.outcome, 'success'); assert.equal(storage.getJob('cli').attemptCount, 1);
  const status = JSON.parse((await exec(process.execPath, [host, 'status', file], { env, timeout: 5000 })).stdout);
  assert.equal(status.ready, true); assert.equal(status.sourceCommit, receipt.sourceSha);
  const stopped = JSON.parse((await exec(process.execPath, [host, 'stop', file], { env, timeout: 25000 })).stdout);
  assert.equal(stopped.confirmedStopped, true);
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  assert.equal(child.exitCode, 0);
  const session = fs.readdirSync(path.join(stateDir, 'sessions')).find(name => name.endsWith('.jsonl'));
  const entries = fs.readFileSync(path.join(stateDir, 'sessions', session), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.filter(entry => entry.type === 'custom' && entry.customType === 'schedule_execution').length, 1);
  assert.equal(entries.some(entry => entry.type === 'message' && entry.message?.role === 'user'), false);
  console.log(JSON.stringify({ sourceCommit: receipt.sourceSha, hostVersion: receipt.hostVersion, nativeCli: true, manifestExtension: true, nativeReceipt: true, confirmedStop: true, inference: 'synthetic-faux-only', globalSettingsChanged: false }));
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 10000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(cwd, { recursive: true, force: true });
}
