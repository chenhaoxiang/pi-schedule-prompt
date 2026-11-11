#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const usage = 'node scripts/retire-expired.mjs --cwd /canonical/project --job EXACT_ID --expected-owner ORIGINAL_SESSION [--apply --sha256 PREVIEW_SHA256]';

export function parseRetirementArguments(args) {
  const values = {}, flags = new Set(['--cwd', '--job', '--expected-owner', '--sha256']);
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--apply' && !apply) { apply = true; continue; }
    if (!flags.has(key) || values[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('arguments');
    values[key] = args[++i];
  }
  if (!values['--cwd'] || !path.isAbsolute(values['--cwd']) || ![values['--job'], values['--expected-owner']].every(v => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v)) ||
      (apply ? !/^[a-f0-9]{64}$/.test(values['--sha256'] ?? '') : values['--sha256'] !== undefined)) throw Error('arguments');
  return { cwd: values['--cwd'], id: values['--job'], owner: values['--expected-owner'], apply, sha256: values['--sha256'] };
}

/** The optional loader is for provider-free tests of the same CLI path, never a command-line module override. */
export async function runRetirement(args, loadStorage = () => import('../dist/storage.js')) {
  const input = parseRetirementArguments(args);
  const cwd = path.resolve(input.cwd);
  if (cwd !== fs.realpathSync(cwd)) throw Error('scope');
  const { CronStorage } = await loadStorage();
  const storage = new CronStorage(cwd);
  const result = input.apply
    ? storage.retireExpiredJob(input.id, input.owner, input.sha256)
    : storage.previewExpiredRetirement(input.id, input.owner);
  return { action: input.apply ? 'retire-expired' : 'preview-retirement', ...result,
    historyRetained: true, ownerChanged: false, effectsReconciled: false,
    executionStarted: false, sdkCreated: false, activeSessionReloaded: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(' ') === '--help') console.log(usage);
  else try { console.log(JSON.stringify(await runRetirement(process.argv.slice(2)), null, 2)); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    const category = ['arguments', 'busy', 'changed', 'expired', 'scope', 'closure', 'pending'].find(label => message.toLowerCase().includes(label)) ?? 'input-or-closure';
    // Never echo a parser exception, source JSON, native message or prompt.
    console.error(`expired-retirement-refused (${category}); no recovery/replay or owner transfer attempted`);
    process.exitCode = 2;
  }
}
