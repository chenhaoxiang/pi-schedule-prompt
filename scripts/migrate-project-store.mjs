#!/usr/bin/env node
import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const usage = 'Usage: migrate-project-store.mjs preview|rollback-check|apply --cwd /canonical/project --agent-dir /canonical/agent [apply only: --source-sha256 HEX --target-sha256 HEX|absent --trusted-project --writers-stopped]';
const digest = /^[a-f0-9]{64}$/;

export async function runProjectCutover(args, loadStorage = () => import('../dist/storage.js')) {
  const [op, ...rest] = args;
  const values = new Map();
  const flags = new Set(['--trusted-project', '--writers-stopped']);
  const keys = new Set(['--cwd', '--agent-dir', '--source-sha256', '--target-sha256']);
  if (!['preview', 'rollback-check', 'apply'].includes(op)) throw new Error(usage);
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (values.has(key)) throw new Error(usage);
    if (flags.has(key)) values.set(key, true);
    else if (keys.has(key) && rest[i + 1] && !rest[i + 1].startsWith('--')) values.set(key, rest[++i]);
    else throw new Error(usage);
  }
  const cwd = values.get('--cwd'), agentDir = values.get('--agent-dir');
  if (![cwd, agentDir].every(dir => typeof dir === 'string' && path.isAbsolute(dir) && realpathSync(dir) === dir && statSync(dir).isDirectory())) throw new Error('Existing canonical project and agent directories required');
  const sourceSha256 = values.get('--source-sha256'), target = values.get('--target-sha256');
  if (op === 'apply') {
    if (!values.has('--trusted-project') || !values.has('--writers-stopped') || !digest.test(sourceSha256 ?? '') || (target !== 'absent' && !digest.test(target ?? ''))) throw new Error(usage);
  } else if (values.size !== 2) throw new Error(usage);
  const { CronStorage } = await loadStorage();
  const storage = new CronStorage(cwd, agentDir);
  if (op === 'preview') return { action: op, ...storage.previewProjectMigration() };
  if (op === 'rollback-check') return { action: op, ...storage.assessProjectRollback() };
  return { action: op, ...storage.importProjectStore({ trustedProject: true, writersConfirmedStopped: true, sourceSha256, targetSha256: target === 'absent' ? null : target }), runtimeQuiescence: 'operator-attested-not-verified-by-cli', executionStarted: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(' ') === '--help') console.log(usage);
  else try { console.log(JSON.stringify(await runProjectCutover(process.argv.slice(2)), null, 2)); }
  catch (error) {
    // Do not echo raw source JSON, filesystem parser exceptions, or prompts.
    const reason = error?.message ?? '';
    const safe = ['requires', 'required', 'held', 'busy', 'changed', 'diverged', 'Conflicting', 'unsettled', 'refusing', 'Invalid schedule store'].some(part => reason.includes(part));
    console.error(reason === usage || (safe && !error?.code) ? reason : 'Project store operation refused or unconfirmed; keep both stores, check exact preview/readback and do not retry an unknown write.');
    process.exitCode = 2;
  }
}
