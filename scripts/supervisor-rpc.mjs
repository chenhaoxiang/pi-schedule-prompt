import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Owned native Pi child only; no terminal attachment or transcript logging. */
export class NativeRpc {
  pending = new Map(); listeners = new Set(); sequence = 0; stderrBytes = 0;
  constructor(executable, args, { cwd, env, onExit = () => {}, onFatal = () => {} }) {
    this.child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    const decoder = new StringDecoder('utf8'); let buffer = '';
    const fail = () => { this.rejectAll(); onFatal(); };
    this.child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { buffer = ''; fail(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { fail(); continue; }
        if (event.type === 'response' && this.pending.has(event.id)) {
          const request = this.pending.get(event.id); this.pending.delete(event.id); clearTimeout(request.timer);
          if (event.success) request.resolve(event.data);
          else request.reject(new Error('Native RPC command rejected')); // Never echo upstream private error bodies.
        } else {
          for (const listener of this.listeners) { try { listener(event); } catch { fail(); } }
        }
      }
    });
    this.child.stderr.on('data', chunk => { this.stderrBytes += chunk.length; });
    this.child.stdin.on('error', fail);
    this.child.on('error', fail);
    this.child.on('close', (code, signal) => {
      this.dead = true; this.rejectAll(); this.resolveExit({ code, signal }); onExit({ code, signal });
    });
  }
  rejectAll() {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Native RPC unavailable; outcome not inferred')); }
    this.pending.clear();
  }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  send(value) {
    if (this.dead || this.child.stdin.destroyed) throw new Error('Native child unavailable');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(type, extra = {}, timeoutMs = 30000) {
    if (this.pending.size >= 16) return Promise.reject(new Error('Too many pending host commands'));
    return new Promise((resolve, reject) => {
      const id = 'host-' + (++this.sequence);
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Native RPC timed out; outcome unknown')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, type, ...extra }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  waitFor(predicate, timeoutMs = 30000) {
    let stop;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('Native readiness event missing')); }, timeoutMs);
      stop = this.onEvent(event => { if (predicate(event)) { clearTimeout(timer); stop(); resolve(event); } });
    });
    // Caller may await a response first; suppress unhandled rejection without swallowing the await result.
    void result.catch(() => {});
    return result;
  }
  async close(graceMs = 5000) {
    if (this.dead) return this.exited;
    // EOF is the native RPC shutdown contract, not a prompt or arbitrary remote kill.
    this.child.stdin.end();
    const term = setTimeout(() => { if (!this.dead) this.child.kill('SIGTERM'); }, graceMs);
    const kill = setTimeout(() => { if (!this.dead) this.child.kill('SIGKILL'); }, graceMs + 2000);
    try { return await this.exited; }
    finally { clearTimeout(term); clearTimeout(kill); }
  }
}
