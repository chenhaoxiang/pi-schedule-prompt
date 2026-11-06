import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Packaged helper is deliberately dependency-free ESM.
import { readConfig } from "../scripts/supervisor.mjs";
import { resilientDefinition } from "../src/resilient-policy.js";
import { CronStorage } from "../src/storage.js";

const root = path.resolve("tmp/native-supervisor-fixtures");
const owned: string[] = []; const children: ChildProcess[] = [];
const hostScript = path.resolve("scripts/supervisor.mjs");
const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
async function port() {
  // Some Linux runners allocate port0 only below49152; never recursively filter their ephemeral range.
  for (let attempt = 0; attempt < 20; attempt++) {
    const selected = randomInt(49152, 65536);
    const server = net.createServer();
    const bound = await new Promise<boolean>((resolve, reject) => {
      server.once("error", error => { if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") resolve(false); else reject(error); });
      server.listen(selected, "127.0.0.1", () => resolve(true));
    });
    if (bound) { await new Promise<void>(resolve => server.close(() => resolve())); return selected; }
  }
  throw new Error("No free fixture control port after20 bounded attempts");
}
async function fixture() {
  fs.mkdirSync(root, { recursive: true }); const cwd = fs.mkdtempSync(path.join(root, "case-")); owned.push(cwd);
  const stateDir = path.join(cwd, "state"); fs.mkdirSync(stateDir, { mode: 0o700 });
  const installed = process.env.PI_SCHEDULE_PACKAGE_ROOT;
  const packageRoot = installed || path.join(cwd, "fixed-package");
  if (!installed) {
    fs.mkdirSync(packageRoot);
    for (const name of ["src", "prompts"]) fs.cpSync(path.resolve(name), path.join(packageRoot, name), { recursive: true });
    fs.copyFileSync(path.resolve("package.json"), path.join(packageRoot, "package.json"));
    fs.symlinkSync(path.resolve("node_modules"), path.join(packageRoot, "node_modules"), "dir");
    fs.writeFileSync(path.join(packageRoot, ".install-receipt.json"), JSON.stringify({ sourceSha: "f".repeat(40), hostVersion: "1.3.0", hostPath: fs.realpathSync(path.resolve("node_modules/@earendil-works/pi-coding-agent")) }));
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(packageRoot, ".install-receipt.json"), "utf8"));
  const bin = path.join(cwd, "host"); fs.mkdirSync(bin);
  const piCli = path.join(bin, "pi"); fs.copyFileSync(path.resolve("test/supervisor-native.mjs"), piCli); fs.chmodSync(piCli, 0o755);
  fs.symlinkSync(path.resolve(receipt.hostPath, "../.."), path.join(bin, "node_modules"), "dir");
  const sourceCommit = receipt.sourceSha;
  const config = { version: 1, cwd, piCli, piCliSha256: digest(fs.readFileSync(piCli)), packageRoot, sourceCommit, sessionId: "supervisor-fixture", model: "durable-fixture/fixture", stateDir, controlPort: await port() };
  const file = path.join(cwd, "config.json"); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return { cwd, config, file, stateDir, storage: new CronStorage(cwd) };
}
function start(file: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [hostScript, "run", file], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  return { child, stderr: () => stderr };
}
function command(op: string, file: string, jobId?: string) {
  return new Promise<{ code: number | null; data: string; error: string }>(resolve => {
    const child = spawn(process.execPath, [hostScript, op, file, ...(jobId ? [jobId] : [])], { stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
    let data = "", error = ""; child.stdout!.on("data", chunk => { data += chunk; }); child.stderr!.on("data", chunk => { error += chunk; }); child.on("exit", code => resolve({ code, data, error }));
  });
}
async function ready(h: Awaited<ReturnType<typeof fixture>>, process: ReturnType<typeof start>) {
  await vi.waitFor(() => {
    if (process.child.exitCode !== null) throw new Error("Fixture host exited before readiness: " + process.stderr());
    const status = JSON.parse(fs.readFileSync(path.join(h.stateDir, "status.json"), "utf8"));
    if (process.child.exitCode !== null) throw new Error("Fixture host exited: " + process.stderr() + (fs.existsSync(path.join(h.cwd, "tmp/native-fixture-error")) ? fs.readFileSync(path.join(h.cwd, "tmp/native-fixture-error"), "utf8") : (fs.existsSync(path.join(h.cwd, "tmp/native-fixture-stderr")) ? fs.readFileSync(path.join(h.cwd, "tmp/native-fixture-stderr"), "utf8") : JSON.stringify(status))));
    const owner = JSON.parse(fs.readFileSync(path.join(h.stateDir, "host.json"), "utf8"));
    expect(owner.pid).toBe(process.child.pid);
    // Recovery writes the new owner record before replacing the previous status.
    // Bind readiness to this exact native child, not a dead child's ready=true.
    expect(owner.childPid).toBeTypeOf("number");
    expect(status.childPid).toBe(owner.childPid);
    expect(status.ready, JSON.stringify(status)).toBe(true);
  }, { timeout: 20000, interval: 100 });
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM"); await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
  for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("dedicated native RPC supervisor service", () => {
  it("preserves every explicit native thinking level including max", async () => {
    const h = await fixture();
    for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      fs.writeFileSync(h.file, JSON.stringify({ ...h.config, thinkingLevel }));
      expect(readConfig(h.file).thinkingLevel).toBe(thinkingLevel);
    }
    fs.writeFileSync(h.file, JSON.stringify(h.config));
    expect(readConfig(h.file).thinkingLevel).toBeUndefined();
    expect(fs.existsSync(path.join(h.stateDir, "host.json"))).toBe(false);
  });
  it("rejects invalid thinking levels before native startup", async () => {
    const h = await fixture();
    for (const thinkingLevel of ["auto", "MAX", "maximum", "", 7, null]) {
      fs.writeFileSync(h.file, JSON.stringify({ ...h.config, thinkingLevel }));
      expect(() => readConfig(h.file)).toThrow("Invalid fixed native supervisor config");
    }
    expect(fs.existsSync(path.join(h.stateDir, "host.json"))).toBe(false);
  });
  it("starts idle with real SDK/RPC, rejects duplicate launcher, denies UI, then stops only its child", async () => {
    const h = await fixture(); const running = start(h.file, { SCHEDULE_FIXTURE_UI: "1" }); await ready(h, running);
    await vi.waitFor(() => expect(fs.readFileSync(path.join(h.cwd, "ui-denied"), "utf8")).toBe("true"));
    expect(fs.existsSync(path.join(h.cwd, "inference-started"))).toBe(false);
    const status = await command("status", h.file); expect(status.code).toBe(0);
    expect(JSON.parse(status.data)).toMatchObject({ ready: true, active: true, jobs: 0, uiDenied: 1, jobStatusFresh: true, jobCounts: { enabled: 0, disabled: 0, disabledUnknown: 0 }, jobSummary: [] });
    const duplicate = start(h.file); await vi.waitFor(() => expect(duplicate.child.exitCode).not.toBeNull(), { timeout: 10000 });
    expect(duplicate.child.exitCode).toBe(1);
    expect(JSON.parse((await command("status", h.file)).data).ready).toBe(true);
    const stop = await command("stop", h.file); expect(stop.code).toBe(0);
    await vi.waitFor(() => expect(running.child.exitCode).toBe(0), { timeout: 12000 });
    expect(JSON.parse((await command("status", h.file)).data)).toMatchObject({ active: false, state: "stopped" });
    expect(running.stderr()).not.toContain("synthetic consent");
  }, 40000);
  it("reports enabled resilient attention once without inferring a wake or requesting a model", async () => {
    const h = await fixture(); h.storage.addJob(resilientDefinition({ id: "native-unavailable", name: "native-unavailable", type: "interval", schedule: "1h", intervalMs: 3600000, prompt: "PRIVATE_NATIVE_PROMPT_MUST_NOT_LEAK", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: h.config.sessionId, maxRuns: 2, expiresAt: new Date(Date.now() + 60000).toISOString(), deadlineMs: 10000 }));
    const running = start(h.file); await ready(h, running);
    const first = JSON.parse((await command("status", h.file)).data);
    expect(first).toMatchObject({ ready: true, active: true, jobStatusFresh: true, jobCounts: { enabled: 1, owned: 0, needsAttention: 1 }, jobSummary: [{ id: "native-unavailable", enabled: true, attemptCount: 0, resilient: { phase: "attention-required", reason: "runtime_unavailable", businessOutcome: "unverified" } }], healthAlerts: [{ jobId: "native-unavailable", reason: "native-attention-required" }] });
    const second = JSON.parse((await command("status", h.file)).data); expect(second.healthAlerts).toHaveLength(1); expect(running.stderr().match(/Scheduling attention required/g)).toHaveLength(1);
    expect(fs.existsSync(path.join(h.cwd, "inference-started"))).toBe(false); expect(JSON.stringify(second)).not.toContain("PRIVATE_NATIVE_PROMPT_MUST_NOT_LEAK");
    await command("stop", h.file); await vi.waitFor(() => expect(running.child.exitCode).toBe(0), { timeout: 12000 });
  }, 35000);
  it("reads health metadata during a live turn without steering or extending the turn", async () => {
    const h = await fixture(); h.storage.addJob({ id: "live", name: "live", type: "once", schedule: new Date(Date.now() + 3000).toISOString(), prompt: "synthetic live status check", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: h.config.sessionId, durable: true, catchUp: "latest", maxRuns: 1, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const running = start(h.file, { SCHEDULE_FIXTURE_BLOCK: "1" }); await ready(h, running);
    await vi.waitFor(() => expect(fs.existsSync(path.join(h.cwd, "inference-started"))).toBe(true), { timeout: 10000 });
    const status = await command("status", h.file);
    expect(status.code, status.error).toBe(0);
    expect(JSON.parse(status.data)).toMatchObject({ ready: true, active: true, jobStatusFresh: true, jobSummary: [{ id: "live", claim: { phase: "started", ownerAlive: true }, reconciliation: "owner-live" }] });
    expect(fs.readFileSync(path.join(h.cwd, "inference-started"), "utf8").trim().split("\n")).toHaveLength(1);
    fs.writeFileSync(path.join(h.cwd, "inference-release"), "ok");
    await vi.waitFor(() => expect(h.storage.getJob("live")?.claim?.outcome).toBe("success"), { timeout: 12000 });
    await command("stop", h.file); await vi.waitFor(() => expect(running.child.exitCode).toBe(0), { timeout: 12000 });
    const sessionFile = fs.readdirSync(path.join(h.stateDir, "sessions")).find(name => name.endsWith(".jsonl"))!;
    const entries = fs.readFileSync(path.join(h.stateDir, "sessions", sessionFile), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.type === "message" && entry.message?.role === "assistant")).toHaveLength(1);
    expect(entries.some(entry => entry.type === "message" && entry.message?.customType === "schedule_host_status")).toBe(false);
  }, 40000);
  it("executes one durable custom turn with a persisted exact native receipt", async () => {
    const h = await fixture(); h.storage.addJob({ id: "once", name: "once", type: "once", schedule: new Date(Date.now() + 4000).toISOString(), prompt: "synthetic bounded check", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: h.config.sessionId, durable: true, catchUp: "latest", maxRuns: 1, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const running = start(h.file); await ready(h, running);
    await vi.waitFor(() => expect(h.storage.getJob("once")?.claim?.outcome).toBe("success"), { timeout: 12000 });
    await vi.waitFor(() => expect(h.storage.getJob("once")).toMatchObject({ enabled: false, runCount: 1, attemptCount: 1, notice: { state: "accepted" } }));
    const sessionFile = fs.readdirSync(path.join(h.stateDir, "sessions")).find(name => name.endsWith(".jsonl"))!;
    const entries = fs.readFileSync(path.join(h.stateDir, "sessions", sessionFile), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.type === "custom" && entry.customType === "schedule_execution")).toHaveLength(1);
    expect(entries.some(entry => entry.type === "message" && entry.message?.role === "user")).toBe(false);
    await command("stop", h.file); await vi.waitFor(() => expect(running.child.exitCode).toBe(0), { timeout: 12000 });
  }, 35000);
  it("refuses a still-live recorded native child after parent interruption; dead handles can recover", async () => {
    const h = await fixture();
    const identity = { ...h.config }; const fingerprint = digest(Buffer.from(JSON.stringify(identity)));
    const record = path.join(h.stateDir, "host.json");
    fs.writeFileSync(record, JSON.stringify({ fingerprint, pid: 2147483647, childPid: process.pid, token: "synthetic" }), { mode: 0o600 });
    const held = start(h.file); await vi.waitFor(() => expect(held.child.exitCode).toBe(1), { timeout: 10000 });
    expect(JSON.parse(fs.readFileSync(record, "utf8")).childPid).toBe(process.pid);
    fs.writeFileSync(record, JSON.stringify({ fingerprint, pid: 2147483647, childPid: 2147483646, token: "synthetic" }));
    const recovered = start(h.file); await ready(h, recovered);
    await command("stop", h.file); await vi.waitFor(() => expect(recovered.child.exitCode).toBe(0), { timeout: 12000 });
  }, 35000);
  it("survives a real parent crash after dispatch without replaying potentially effectful work", async () => {
    const h = await fixture(); h.storage.addJob({ id: "crash", name: "crash", type: "once", schedule: new Date(Date.now() + 3000).toISOString(), prompt: "synthetic delayed check", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: h.config.sessionId, durable: true, catchUp: "latest", maxRuns: 1, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const running = start(h.file, { SCHEDULE_FIXTURE_DELAY: "1" }); await ready(h, running);
    await vi.waitFor(() => expect(fs.existsSync(path.join(h.cwd, "inference-started"))).toBe(true), { timeout: 10000 });
    const childPid = JSON.parse(fs.readFileSync(path.join(h.stateDir, "host.json"), "utf8")).childPid;
    running.child.kill("SIGKILL"); // Exact fixture-owned parent handle, never an arbitrary peer/PID.
    await vi.waitFor(() => expect(running.child.signalCode).toBe("SIGKILL"));
    await vi.waitFor(() => {
      let present = true; try { process.kill(childPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") present = false; }
      expect(present).toBe(false);
    }, { timeout: 12000 });
    const recovered = start(h.file); await ready(h, recovered);
    expect(h.storage.getJob("crash")).toMatchObject({ enabled: false, attemptCount: 1, claim: { phase: "settled", outcome: "unknown" } });
    const before = fs.readFileSync(h.storage.getStorePath(), "utf8");
    const status = JSON.parse((await command("status", h.file)).data);
    expect(status).toMatchObject({ ready: true, active: true, jobStatusFresh: true, jobCounts: { enabled: 0, disabled: 1, disabledUnknown: 1 }, jobSummary: [{ id: "crash", enabled: false, operationalState: "disabled-unknown" }], healthAlerts: [{ jobId: "crash", reason: "disabled-unknown" }] });
    const reconciled = await command("reconcile", h.file, "crash");
    expect(reconciled.code, reconciled.error).toBe(0);
    expect(JSON.parse(reconciled.data)).toMatchObject({ readOnly: true, found: true, modified: false, automaticReplay: false, businessCompletion: "not-verified", job: { id: "crash", reconciliation: "unknown-needs-external-reconciliation" } });
    expect(fs.readFileSync(h.storage.getStorePath(), "utf8")).toBe(before);
    expect(JSON.parse((await command("status", h.file)).data).healthAlerts).toHaveLength(1);
    expect(recovered.stderr().match(/Scheduling attention required/g)).toHaveLength(1);
    expect(fs.readFileSync(path.join(h.cwd, "inference-started"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(JSON.parse((await command("stop", h.file)).data)).toMatchObject({ confirmedStopped: true });
    await vi.waitFor(() => expect(recovered.child.exitCode).toBe(0), { timeout: 12000 });
  }, 40000);
  it("rejects binary pin drift and non-durable service tasks without inference", async () => {
    const h = await fixture(); fs.writeFileSync(h.file, JSON.stringify({ ...h.config, piCliSha256: "0".repeat(64) }));
    const mismatch = start(h.file); await vi.waitFor(() => expect(mismatch.child.exitCode).toBe(1));
    fs.writeFileSync(h.file, JSON.stringify(h.config));
    h.storage.addJob({ id: "legacy", name: "legacy", type: "interval", schedule: "1s", intervalMs: 1000, prompt: "not service eligible", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: h.config.sessionId });
    const legacy = start(h.file); await vi.waitFor(() => expect(legacy.child.exitCode).toBe(1));
    expect(fs.existsSync(path.join(h.cwd, "inference-started"))).toBe(false);
  });
  it("resumes the exact existing native transcript with a hard read-only builtin registry", async () => {
    const h = await fixture(); h.storage.addJob({ id: "retained", name: "retained", type: "once", schedule: new Date(Date.now() + 3000).toISOString(), prompt: "synthetic retained result", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: h.config.sessionId, durable: true, catchUp: "latest", maxRuns: 1, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const first = start(h.file); await ready(h, first);
    await vi.waitFor(() => expect(h.storage.getJob("retained")?.notice?.state).toBe("accepted"), { timeout: 12000 });
    expect((await command("stop", h.file)).code).toBe(0); await vi.waitFor(() => expect(first.child.exitCode).toBe(0), { timeout: 12000 });
    const oldStatus = JSON.parse(fs.readFileSync(path.join(h.stateDir, "status.json"), "utf8"));
    const sessionFile = oldStatus.nativeIdentity.sessionFile; const before = fs.readFileSync(sessionFile);
    const storeBefore = fs.readFileSync(h.storage.getStorePath());
    const stateDir = path.join(h.cwd, "resumed-state"); fs.mkdirSync(stateDir, { mode: 0o700 });
    const file = path.join(h.cwd, "resume.json"); fs.writeFileSync(file, JSON.stringify({ ...h.config, stateDir, sessionFile, toolProfile: "read-only" }), { mode: 0o600 });
    const resumed = start(file); await ready({ ...h, file, stateDir }, resumed);
    const status = JSON.parse((await command("status", file)).data);
    expect(status).toMatchObject({ ready: true, active: true, toolProfile: "read-only", toolProfileVerified: true, nativeIdentity: { sessionFile, sessionId: h.config.sessionId }, runtime: { sessionFile, tools: { state: "observed", truncated: false } } });
    expect(status.runtime.tools.active.sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(status.runtime.tools.registered.map((tool: any) => [tool.name, tool.source, tool.path, tool.exposure]).sort()).toEqual(["find", "grep", "ls", "read"].map(name => [name, "builtin", "builtin:" + name, "direct"]));
    expect(fs.readFileSync(sessionFile).subarray(0, before.length)).toEqual(before);
    expect(fs.readdirSync(path.join(stateDir, "sessions"))).toHaveLength(0);
    expect(fs.readFileSync(h.storage.getStorePath())).toEqual(storeBefore);
    expect(fs.readFileSync(path.join(h.cwd, "inference-started"), "utf8").trim().split("\n")).toHaveLength(1);
    expect((await command("stop", file)).code).toBe(0); await vi.waitFor(() => expect(resumed.child.exitCode).toBe(0), { timeout: 12000 });
  }, 45000);
  it("rejects invalid tool profiles and foreign/missing/symlinked session files before native launch", async () => {
    const h = await fixture();
    fs.writeFileSync(h.file, JSON.stringify({ ...h.config, toolProfile: "arbitrary-shell" }));
    expect((await command("plist", h.file)).code).toBe(1);
    const directory = path.join(h.cwd, "private-sessions"); fs.mkdirSync(directory, { mode: 0o700 });
    const sessionFile = path.join(directory, "retained.jsonl");
    const header = { type: "session", version: 3, id: h.config.sessionId, cwd: h.cwd, timestamp: new Date().toISOString() };
    fs.writeFileSync(sessionFile, JSON.stringify(header) + "\n", { mode: 0o600 });
    const link = path.join(directory, "link.jsonl"); fs.symlinkSync(sessionFile, link);
    for (const selected of [path.join(directory, "missing.jsonl"), link, directory]) {
      fs.writeFileSync(h.file, JSON.stringify({ ...h.config, sessionFile: selected }));
      const blocked = start(h.file); await vi.waitFor(() => expect(blocked.child.exitCode).toBe(1), { timeout: 10000 });
      expect(fs.existsSync(path.join(h.stateDir, "host.json"))).toBe(false);
    }
    for (const changed of [{ ...header, id: "foreign" }, { ...header, cwd: path.dirname(h.cwd) }]) {
      fs.writeFileSync(sessionFile, JSON.stringify(changed) + "\n");
      fs.writeFileSync(h.file, JSON.stringify({ ...h.config, sessionFile }));
      const blocked = start(h.file); await vi.waitFor(() => expect(blocked.child.exitCode).toBe(1), { timeout: 10000 });
      expect(blocked.stderr()).toContain("header/cwd identity mismatch");
    }
    fs.writeFileSync(h.file, JSON.stringify({ ...h.config, toolProfile: "read-only" }));
    h.storage.addJob({ id: "explicit-model", name: "explicit-model", type: "once", schedule: new Date(Date.now() + 10000).toISOString(), prompt: "must not create a separate unrestricted SDK child", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: h.config.sessionId, model: "durable-fixture/fixture", durable: true, maxRuns: 1, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const model = start(h.file); await vi.waitFor(() => expect(model.child.exitCode).toBe(1), { timeout: 10000 });
    expect(model.stderr()).toContain("read-only profile requires inline jobs");
    expect(fs.existsSync(path.join(h.cwd, "inference-started"))).toBe(false);
  }, 40000);
  it("prints an opt-in launchd definition without starting or installing a service", async () => {
    const h = await fixture(); const result = await command("plist", h.file);
    expect(result.code).toBe(0); expect(result.data).toContain("<key>Crashed</key><true/>"); expect(result.data).toContain("<integer>60</integer>");
    expect(fs.existsSync(path.join(h.stateDir, "host.json"))).toBe(false);
    expect(result.data).not.toContain("token");
  });
});
