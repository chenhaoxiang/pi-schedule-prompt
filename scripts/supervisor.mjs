#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeRpc } from './supervisor-rpc.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return true; // Incomplete record is not death proof.
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
const privateDir = directory => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Host state directory must be owned and private (0700)');
};
const atomic = (file, data) => {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
};
export function readConfig(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Config must be a private regular file <=8KiB');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = ['version', 'cwd', 'piCli', 'piCliSha256', 'packageRoot', 'sourceCommit', 'sessionId', 'model', 'thinkingLevel', 'stateDir', 'controlPort'];
  if (!config || config.version !== 1 || Object.keys(config).some(key => !keys.includes(key)) ||
    !['cwd', 'piCli', 'packageRoot', 'stateDir'].every(key => typeof config[key] === 'string' && path.isAbsolute(config[key]) && path.normalize(config[key]) === config[key]) ||
    !/^[a-f0-9]{64}$/.test(config.piCliSha256) || !/^[a-f0-9]{40}$/.test(config.sourceCommit) ||
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/.test(config.sessionId) ||
    typeof config.model !== 'string' || !/^[a-zA-Z0-9_.-]+\/[^\s:]+$/.test(config.model) ||
    (config.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(config.thinkingLevel))) throw new Error('Invalid fixed native supervisor config');
  if (!Number.isInteger(config.controlPort) || config.controlPort < 49152 || config.controlPort > 65535) throw new Error('controlPort must be a selected loopback port 49152–65535');
  return { ...config, fingerprint: sha(JSON.stringify(config)) };
}

function validatePins(config) {
  if (sha(fs.readFileSync(config.piCli)) !== config.piCliSha256) throw new Error('Pi CLI pin mismatch');
  const receipt = JSON.parse(fs.readFileSync(path.join(config.packageRoot, '.install-receipt.json'), 'utf8'));
  if (receipt.sourceSha !== config.sourceCommit || !/^1\.3\.\d+(?:-fork\.\d+)?$/.test(receipt.hostVersion)) throw new Error('Fixed installation receipt mismatch');
  if (typeof receipt.hostPath !== 'string' || fs.realpathSync(path.join(path.dirname(config.piCli), 'node_modules/@earendil-works/pi-coding-agent')) !== receipt.hostPath || JSON.parse(fs.readFileSync(path.join(receipt.hostPath, 'package.json'), 'utf8')).version !== receipt.hostVersion) throw new Error('CLI and fixed installer host bindings differ');
  if (fs.realpathSync(config.packageRoot) !== config.packageRoot || fs.realpathSync(config.cwd) !== config.cwd) throw new Error('Use canonical cwd/package paths');
  const storePath = path.join(config.cwd, '.pi/schedule-prompts.json');
  if (fs.existsSync(storePath)) {
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (![1, 2, 3].includes(store.version) || !Array.isArray(store.jobs) || store.jobs.some(job => job.enabled && (!job.session || (job.session === config.sessionId && (!job.durable || !job.maxRuns || !job.expiresAt))))) throw new Error('Dedicated host requires finite durable session-bound schedules');
  }
}

async function control(config, op, jobId) {
  const recordFile = path.join(config.stateDir, 'host.json');
  if (!fs.existsSync(recordFile)) {
    if (op === 'status') return { ...(fs.existsSync(path.join(config.stateDir, 'status.json')) ? JSON.parse(fs.readFileSync(path.join(config.stateDir, 'status.json'), 'utf8')) : { state: 'stopped' }), active: false };
    throw new Error('No owned host; nothing was signalled');
  }
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  if (record.fingerprint !== config.fingerprint) throw new Error('Host config differs from the running owner');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: config.controlPort }); let buffer = '';
    socket.setTimeout(5000);
    socket.on('connect', () => socket.write(JSON.stringify({ token: record.token, op, ...(jobId ? { jobId } : {}) }) + '\n'));
    socket.on('data', chunk => { buffer += chunk; if (Buffer.byteLength(buffer) > 131072) { socket.destroy(); reject(new Error('Invalid host response')); } else if (buffer.includes('\n')) { socket.end(); try { resolve(JSON.parse(buffer.split('\n')[0])); } catch { reject(new Error('Invalid host response')); } } });
    socket.on('error', () => reject(new Error('Owned control unavailable; retained owner/child requires reconciliation, not arbitrary PID kill')));
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Owned control timed out; stop not confirmed')); });
  });
}

export async function run(config) {
  privateDir(config.stateDir);
  validatePins(config);
  const identityFile = path.join(config.stateDir, 'identity.json');
  try { fs.writeFileSync(identityFile, JSON.stringify({ fingerprint: config.fingerprint }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || JSON.parse(fs.readFileSync(identityFile, 'utf8')).fingerprint !== config.fingerprint) throw new Error('State directory already belongs to a different fixed config'); }
  const recordFile = path.join(config.stateDir, 'host.json');
  const token = randomBytes(32).toString('hex');
  let owned = false;
  let record = { version: 1, pid: process.pid, childPid: null, fingerprint: config.fingerprint, token };
  const stateFile = path.join(config.stateDir, 'status.json');
  const state = { version: 1, state: 'starting', ready: false, sessionId: config.sessionId, sourceCommit: config.sourceCommit, packageRoot: config.packageRoot, stateDir: config.stateDir, childPid: null, uiDenied: 0, stderrBytes: 0, jobStatusFresh: false, healthAlerts: [] };
  try {
    const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (previous.sessionId === config.sessionId && previous.sourceCommit === config.sourceCommit && Array.isArray(previous.healthAlerts)) state.healthAlerts = previous.healthAlerts.slice(-20);
  } catch { /* A missing prior display snapshot is not execution evidence. */ }
  const persist = () => atomic(stateFile, { ...state, updatedAt: new Date().toISOString() });
  let rpc, server, stopping;
  let refreshing;
  const readJobs = async (jobId, timeoutMs = 1500) => {
    const requestId = randomBytes(16).toString('hex');
    const event = rpc.waitFor(event => {
      if (event.type !== 'extension_ui_request' || event.method !== 'setStatus' || event.statusKey !== 'schedule_host_status' || typeof event.statusText !== 'string') return false;
      try { return JSON.parse(event.statusText).requestId === requestId; } catch { return false; }
    }, timeoutMs);
    const disposition = await rpc.request('prompt', { message: '/schedule-host-status ' + requestId + (jobId ? ' ' + jobId : '') }, timeoutMs);
    if (disposition.disposition !== 'handled') throw new Error('Native status command was not handled locally');
    const details = JSON.parse((await event).statusText);
    if (details.pid !== rpc.child.pid || details.sessionId !== config.sessionId) throw new Error('Native status identity mismatch');
    return details;
  };
  const refreshJobs = () => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const details = await readJobs();
        state.jobs = details.jobs; state.jobCounts = details.counts;
        state.jobSummary = details.jobSummary; state.jobSummaryTruncated = details.jobSummaryTruncated;
        state.jobStatusFresh = true; state.jobStatusObservedAt = new Date().toISOString();
        for (const job of details.jobSummary ?? []) {
          if (job.operationalState !== 'disabled-unknown' && !(job.enabled === false && job.lastStatus === 'error')) continue;
          const key = sha(JSON.stringify([job.id, job.claim?.id, job.claim?.outcome, job.lastStatus]));
          if (state.healthAlerts.some(alert => alert.key === key)) continue;
          const alert = { key, jobId: job.id, ...(job.claim ? { claimId: job.claim.id } : {}), reason: job.operationalState === 'disabled-unknown' ? 'disabled-unknown' : 'disabled-error', observedAt: state.jobStatusObservedAt };
          state.healthAlerts = [...state.healthAlerts, alert].slice(-20);
          console.error('Scheduling attention required: ' + JSON.stringify(alert));
        }
      } catch {
        state.jobStatusFresh = false;
      }
      if (owned) persist();
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  const shutdown = (reason = 'requested') => {
    if (stopping) return stopping;
    stopping = (async () => {
      state.state = 'stopping'; state.ready = false; state.jobStatusFresh = false; if (owned) persist();
      if (rpc && !rpc.dead) {
        // Only own native queue/session, never an Intercom peer or detached Subagents handle.
        try { await rpc.request('clear_queue', {}, 2000); } catch { /* EOF still disposes runtime. */ }
        try { await rpc.request('abort', {}, 3000); } catch { /* bounded shutdown, not completion proof */ }
        await rpc.close();
      }
      if (rpc) state.stderrBytes = rpc.stderrBytes;
      state.state = reason === 'requested' ? 'stopped' : reason; if (owned) persist();
      if (server) await new Promise(resolve => server.close(resolve));
      try {
        const current = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
        if (owned && current.token === token) fs.rmSync(recordFile);
      } catch { /* Leave an uncertain record, never delete another owner. */ }
    })();
    return stopping;
  };
  const onSignal = () => { void shutdown().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  try {
    server = net.createServer(socket => {
      let buffer = ''; socket.setTimeout(5000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 1024) { socket.destroy(); return; }
        if (!buffer.includes('\n')) return;
        let request;
        try { request = JSON.parse(buffer.split('\n')[0]); } catch { socket.destroy(); return; }
        if (!owned || typeof request.token !== 'string' || !timingSafeEqual(Buffer.from(sha(request.token)), Buffer.from(sha(token))) || !['status', 'reconcile', 'stop'].includes(request.op) || Object.keys(request).some(key => !['token', 'op', 'jobId'].includes(key)) || (request.op === 'reconcile' ? !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(request.jobId ?? '') : request.jobId !== undefined)) { socket.destroy(); return; }
        if (request.op === 'status' || request.op === 'reconcile') {
          const respond = async () => {
            if (request.op === 'reconcile') {
              const details = await readJobs(request.jobId);
              socket.end(JSON.stringify({ readOnly: true, jobId: request.jobId, found: details.jobSummary?.length === 1, job: details.jobSummary?.[0], receiptScope: 'owning-native-session', automaticReplay: false, modified: false, businessCompletion: 'not-verified' }) + '\n');
            } else {
              if (state.ready && !stopping) await refreshJobs();
              socket.end(JSON.stringify({ ...state, stderrBytes: rpc?.stderrBytes ?? 0, active: !!rpc && !rpc.dead }) + '\n');
            }
          };
          void respond().catch(() => socket.end(JSON.stringify({ state: 'metadata-unavailable', readOnly: true, modified: false, automaticReplay: false }) + '\n'));
        } else {
          // Close this request before server.close(), then await actual child exit before acknowledgement.
          socket.end(JSON.stringify({ state: 'stop-requested', confirmedStopped: false }) + '\n');
          void shutdown().catch(() => { process.exitCode = 1; });
        }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: config.controlPort, exclusive: true }, resolve); });
    // Kernel-held endpoint serializes same-config launch/recovery without a stale file-lock race.
    if (fs.existsSync(recordFile)) {
      const previous = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      if (previous.fingerprint !== config.fingerprint || alive(previous.pid) || alive(previous.childPid)) throw new Error('Existing owner/child may be live or scope differs; second launcher refused');
      atomic(recordFile, record);
    } else fs.writeFileSync(recordFile, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    owned = true; persist();
    privateDir(path.join(config.stateDir, 'sessions'));
    // The fixed supervisor must load exactly its pinned extension. A normal Pi
    // session may also have a git-installed scheduler in settings; discovering
    // both copies causes a schedule_prompt tool collision and prevents readiness.
    const args = ['--mode', 'rpc', '--offline', '--no-extensions', '--session-id', config.sessionId, '--session-dir', path.join(config.stateDir, 'sessions'), '--model', config.model, '--extension', config.packageRoot, '--prompt-template', path.join(config.packageRoot, 'prompts')];
    if (config.thinkingLevel !== undefined) args.push('--thinking', config.thinkingLevel);
    rpc = new NativeRpc(config.piCli, args, { cwd: config.cwd, env: { ...process.env, PI_SCHEDULE_SERVICE_SESSION: config.sessionId },
      onExit: () => { if (!stopping) void shutdown('native-exited'); },
      onFatal: () => { if (!stopping) void shutdown('rpc-unavailable'); } });
    record = { ...record, childPid: rpc.child.pid }; atomic(recordFile, record);
    state.childPid = rpc.child.pid; persist();
    rpc.onEvent(event => {
      if (event.type === 'agent_start') { state.state = 'running'; state.jobStatusFresh = false; persist(); }
      if (event.type === 'agent_settled') { state.state = 'idle-ready'; persist(); if (state.ready && !stopping) void refreshJobs(); }
      if (event.type === 'extension_ui_request') {
        if (['confirm', 'select', 'input', 'editor'].includes(event.method)) {
          state.uiDenied += 1; persist();
          rpc.send({ type: 'extension_ui_response', id: event.id, ...(event.method === 'confirm' ? { confirmed: false } : { cancelled: true }) });
        }
      }
    });
    state.step = 'get-state'; persist();
    const native = await rpc.request('get_state');
    state.step = 'verify-native-identity'; persist();
    if (native.sessionId !== config.sessionId || native.model?.provider + '/' + native.model?.id !== config.model || !native.sessionFile || !path.resolve(native.sessionFile).startsWith(path.join(config.stateDir, 'sessions') + path.sep)) throw new Error('Native session/model identity mismatch');
    state.step = 'get-commands'; persist();
    const { commands } = await rpc.request('get_commands');
    state.step = 'verify-loaded-package'; persist();
    if (!commands.some(command => command.name === 'schedule-host-status' && command.sourceInfo?.path === path.join(config.packageRoot, 'src/index.ts'))) throw new Error('Pinned scheduler command not loaded');
    state.step = 'readiness-handshake'; persist();
    const ready = await readJobs(undefined, 30000);
    if (!ready.ready) throw new Error('Scheduler not ready in the owned native process');
    const current = await rpc.request('get_state');
    state.state = current.isStreaming ? 'running' : 'idle-ready'; state.ready = true; persist();
    await refreshJobs();
    await rpc.exited;
    await shutdown('native-exited');
  } catch {
    await shutdown('blocked');
    throw new Error('Dedicated native host blocked; inspect private status metadata; no business completion or automatic retry inferred');
  } finally {
    process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
  }
}

export function plist(config, configFile) {
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const args = [process.execPath, fileURLToPath(import.meta.url), 'run', path.resolve(configFile)].map(value => '<string>' + escape(value) + '</string>').join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>local.pi-schedule.${escape(config.sessionId)}</string><key>ProgramArguments</key><array>${args}</array><key>WorkingDirectory</key><string>${escape(config.cwd)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>Crashed</key><true/></dict><key>ThrottleInterval</key><integer>60</integer><key>ProcessType</key><string>Background</string></dict></plist>\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [op, file, jobId] = process.argv.slice(2);
    if (!['run', 'status', 'reconcile', 'stop', 'plist'].includes(op) || !file || (op === 'reconcile' ? process.argv.length !== 5 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(jobId ?? '') : process.argv.length !== 4)) throw new Error('Usage: supervisor.mjs run|status|stop|plist /private/config.json OR reconcile /private/config.json <jobId>');
    const config = readConfig(path.resolve(file));
    if (op === 'run') await run(config);
    else if (op === 'plist') process.stdout.write(plist(config, file));
    else if (op === 'status' || op === 'reconcile') console.log(JSON.stringify(await control(config, op, jobId)));
    else {
      const accepted = await control(config, 'stop');
      if (accepted.state !== 'stop-requested') throw new Error('Stop was not accepted');
      const deadline = Date.now() + 20000;
      while (fs.existsSync(path.join(config.stateDir, 'host.json')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (fs.existsSync(path.join(config.stateDir, 'host.json'))) throw new Error('Stop timeout; owned process outcome not confirmed');
      console.log(JSON.stringify({ state: 'stopped', confirmedStopped: true }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
