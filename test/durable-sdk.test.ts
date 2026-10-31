import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import schedule from "../src/index.js";
import { CronStorage } from "../src/storage.js";

describe("native receipt recovery read/write path", () => {
  it("reads the real native custom entry on reload after a lost terminal store update without new inference", async () => {
    const base = path.resolve("tmp/durable-sdk-fixtures"); fs.mkdirSync(base, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(base, "case-")); const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir);
    const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
    const storage = new CronStorage(cwd);
    storage.addJob({ id: "receipt", name: "receipt", type: "once", schedule: new Date(Date.now() + 500).toISOString(), prompt: "Synthetic receipt check", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: manager.getSessionId(), durable: true, catchUp: "latest", maxRuns: 1 });
    const lostWrite = vi.spyOn(CronStorage.prototype, "settleClaim").mockImplementationOnce(() => { throw new Error("synthetic terminal write loss"); });
    const faux = fauxProvider({ provider: "durable-receipt-fixture" }); faux.setResponses([fauxAssistantMessage("RECEIPT_OK")]);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false }); runtime.registerNativeProvider(faux.provider);
    const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [schedule] }); await loader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", tools: [], settingsManager: settings, sessionManager: manager, resourceLoader: loader });
    try {
      await session.bindExtensions({ mode: "rpc" });
      await vi.waitFor(() => expect(manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "schedule_execution")).toHaveLength(1), { timeout: 7000 }); await session.waitForIdle();
      expect(storage.getJob("receipt")?.claim?.phase).toBe("started");
      const entries = manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "schedule_execution");
      expect(entries).toHaveLength(1);
      const bytes = fs.readFileSync(manager.getSessionFile()!, "utf8"); expect(bytes).toContain('"customType":"schedule_execution"');
      await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      expect(storage.getJob("receipt")).toMatchObject({ attemptCount: 1, enabled: false, claim: { phase: "settled", outcome: "success" }, notice: { state: "accepted" } });
      expect(faux.state.callCount).toBe(1);
    } finally {
      lostWrite.mockRestore(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
