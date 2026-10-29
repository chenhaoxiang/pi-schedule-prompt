import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import scheduleExtension from "../src/index.js";
import { CronStorage } from "../src/storage.js";
import { runSubagentOnce } from "../src/subagent.js";

// Real Pi lifecycle + faux inference. No HOME discovery, credentials, network or paid calls.
describe("Pi 1.3 native host integration", () => {
  it("executes one source-preserving custom turn and retains paused jobs on shutdown", async () => {
    const root = path.resolve("tmp/sdk-fixtures");
    fs.mkdirSync(root, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(root, "case-"));
    const agentDir = path.join(cwd, "agent");
    fs.mkdirSync(agentDir);
    const manager = SessionManager.inMemory(cwd);
    const storage = new CronStorage(cwd);
    storage.addJob({ id: "wake", name: "one wake", type: "once", schedule: new Date(Date.now() + 600).toISOString(),
      prompt: "Reply FIXTURE_OK", enabled: true, createdAt: new Date().toISOString(), runCount: 0,
      session: manager.getSessionId() });
    storage.addJob({ id: "paused", name: "paused", type: "interval", schedule: "1h", intervalMs: 3600000,
      prompt: "Do not run", enabled: false, createdAt: new Date().toISOString(), runCount: 0,
      session: manager.getSessionId() });
    const faux = fauxProvider({ provider: "schedule-fixture" });
    faux.setResponses([fauxAssistantMessage("FIXTURE_OK")]);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey("schedule-fixture", "synthetic-fixture-only");
    const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
    const sources: string[] = [];
    const errors: string[] = [];
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [scheduleExtension, pi => {
        pi.on("before_agent_start", event => { sources.push(event.messageType); });
      }] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(),
      thinkingLevel: "off", tools: [], settingsManager: settings, sessionManager: manager, resourceLoader: loader });
    try {
      await session.bindExtensions({ mode: "rpc", onError: error => { errors.push(error.message); } });
      await vi.waitFor(() => expect(session.getLastAssistantText()).toBe("FIXTURE_OK"), { timeout: 5000 });
      expect(sources).toEqual(["custom"]);
      expect(faux.state.callCount).toBe(1);
      expect(session.messages.filter(message => message.role === "user")).toHaveLength(0);
      expect(storage.getJob("wake")?.lastStatus).toBe("dispatched");
      expect(errors).toEqual([]);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      expect(storage.getJob("paused")?.enabled).toBe(false);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("runs an explicit model job with the real SDK and a native faux provider", async () => {
    const root = path.resolve("tmp/sdk-fixtures");
    fs.mkdirSync(root, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(root, "model-"));
    const agentDir = path.join(cwd, "agent");
    fs.mkdirSync(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      expect(getAgentDir()).toBe(agentDir);
      const faux = fauxProvider({ provider: "schedule-model-fixture" });
      faux.setResponses([fauxAssistantMessage("MODEL_FIXTURE_OK")]);
      const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
      runtime.registerNativeProvider(faux.provider);
      const registry = new ModelRegistry(runtime);
      const modelRegistry = {
        find: registry.find.bind(registry),
        getAvailable: () => [faux.getModel()],
        getRegisteredNativeProvider: registry.getRegisteredNativeProvider?.bind(registry),
        getRegisteredProviderConfig: registry.getRegisteredProviderConfig?.bind(registry),
      };
      const result = await runSubagentOnce({ cwd, modelRegistry, thinkingLevel: "off" } as any,
        "Reply MODEL_FIXTURE_OK without tools", "schedule-model-fixture/" + faux.getModel().id);
      expect(result).toEqual({ ok: true, text: "MODEL_FIXTURE_OK" });
      expect(faux.state.callCount).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

});
