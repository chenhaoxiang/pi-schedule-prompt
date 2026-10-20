import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("online supervisor composition", () => {
  it.each(["online", "offline"])("verifies %s supervision using native Pi tools and an isolated real Intercom broker", async (scenario) => {
    const base = path.resolve(process.env.PI_SCHEDULE_FIXTURE_ROOT || path.join(tmpdir(), "tmp/sp"));
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, "case-"));
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(agentDir, "intercom"), { recursive: true });
    const socketPath = path.join(agentDir, "intercom/broker.sock");
    if (Buffer.byteLength(socketPath) >= 104) {
      fs.rmSync(root, { recursive: true, force: true });
      throw new Error("Set PI_SCHEDULE_FIXTURE_ROOT to a short dedicated tmp/ directory (Unix socket path limit)");
    }
    fs.writeFileSync(path.join(agentDir, "intercom/config.json"), JSON.stringify({ enabled: true, inboundTrigger: "replies", confirmSend: false }));
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, path.resolve("test/online-smoke.mjs")], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_SCHEDULE_FIXTURE_CASE: root, PI_SCHEDULE_SCENARIO: scenario, NODE_NO_WARNINGS: "1",
        ...(process.env.PI_SCHEDULE_HOST_ENTRY ? { PI_SCHEDULE_HOST_ENTRY: process.env.PI_SCHEDULE_HOST_ENTRY } : {}),
        ...(process.env.PI_SCHEDULE_EXTENSION_ENTRY ? { PI_SCHEDULE_EXTENSION_ENTRY: process.env.PI_SCHEDULE_EXTENSION_ENTRY } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-20000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-20000); });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const deadline = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Online fixture deadline: " + stderr)); }, 35000);
        child.once("error", error => { clearTimeout(deadline); reject(error); });
        child.once("exit", value => { clearTimeout(deadline); resolve(value); });
      });
      expect(code, stderr + stdout).toBe(0);
      const line = stdout.split("\n").find(item => item.startsWith('{"ok":true'));
      expect(line, stderr + stdout).toBeDefined();
      const result = JSON.parse(line!);
      expect(result).toMatchObject({ scenario, realBroker: true, realProviderCalls: 0, businessSessionsTouched: 0 });
      if (scenario === "online") expect(result).toMatchObject({ nativePiSessions: 3, peerGoalsVerified: 2, supervisorChecks: 2, stopped: true });
      else expect(result).toMatchObject({ nativePiSessions: 1, offlineDetected: true, replacementCreated: false });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 40000);
});
