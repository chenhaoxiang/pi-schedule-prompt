import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronStorage } from "../src/storage.js";

const root = path.resolve("tmp/native-supervisor-fixtures");
const owned: string[] = []; const children: ChildProcess[] = [];
const hostScript = path.resolve("scripts/supervisor.mjs");
const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
async function port() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const selected = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (selected < 49152) return port();
  return selected;
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
function command(op: string, file: string) {
  return new Promise<{ code: number | null; data: string; error: string }>(resolve => {
    const child = spawn(process.execPath, [hostScript, op, file], { stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
    let data = "", error = ""; child.stdout!.on("data", chunk => { data += chunk; }); child.stderr!.on("data", chunk => { error += chunk; }); child.on("exit", code => resolve({ code, data, error }));
  });
}
async function ready(h: Awaited<ReturnType<typeof fixture>>, process: ReturnType<typeof start>) {
  await vi.waitFor(() => {
    const status = JSON.parse(fs.readFileSync(path.join(h.stateDir, "status.json"), "utf8"));
    if (process.child.exitCode !== null) throw new Error("Fixture host exited: " + process.stderr() + (fs.existsSync(path.join(h.cwd, "tmp/native-fixture-error")) ? fs.readFileSync(path.join(h.cwd, "tmp/native-fixture-error"), "utf8") : (fs.existsSync(path.join(h.cwd, "tmp/native-fixture-stderr")) ? fs.readFileSync(path.join(h.cwd, "tmp/native-fixture-stderr"), "utf8") : JSON.stringify(status))));
    expect(JSON.parse(fs.readFileSync(path.join(h.stateDir, "host.json"), "utf8")).pid).toBe(process.child.pid);
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
  it("starts idle with real SDK/RPC, rejects duplicate launcher, denies UI, then stops only its child", async () => {
    const h = await fixture(); const running = start(h.file, { SCHEDULE_FIXTURE_UI: "1" }); await ready(h, running);
    await vi.waitFor(() => expect(fs.readFileSync(path.join(h.cwd, "ui-denied"), "utf8")).toBe("true"));
    expect(fs.existsSync(path.join(h.cwd, "inference-started"))).toBe(false);
    const status = await command("status", h.file); expect(status.code).toBe(0);
    expect(JSON.parse(status.data)).toMatchObject({ ready: true, active: true, jobs: 0, uiDenied: 1 });
    const duplicate = start(h.file); await vi.waitFor(() => expect(duplicate.child.exitCode).not.toBeNull(), { timeout: 10000 });
    expect(duplicate.child.exitCode).toBe(1);
    expect(JSON.parse((await command("status", h.file)).data).ready).toBe(true);
    const stop = await command("stop", h.file); expect(stop.code).toBe(0);
    await vi.waitFor(() => expect(running.child.exitCode).toBe(0), { timeout: 12000 });
    expect(JSON.parse((await command("status", h.file)).data)).toMatchObject({ active: false, state: "stopped" });
    expect(running.stderr()).not.toContain("synthetic consent");
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
  it("prints an opt-in launchd definition without starting or installing a service", async () => {
    const h = await fixture(); const result = await command("plist", h.file);
    expect(result.code).toBe(0); expect(result.data).toContain("<key>Crashed</key><true/>"); expect(result.data).toContain("<integer>60</integer>");
    expect(fs.existsSync(path.join(h.stateDir, "host.json"))).toBe(false);
    expect(result.data).not.toContain("token");
  });
});
