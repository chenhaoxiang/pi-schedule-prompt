import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";

// The maintained 0.5.x store is keyed under PI_CODING_AGENT_DIR. Keep the
// provider-free suite fully isolated from the user's real Pi agent directory.
const root = resolve("tmp/vitest-agent-dirs");
mkdirSync(root, { recursive: true, mode: 0o700 });
const agentDir = mkdtempSync(join(root, "agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});
