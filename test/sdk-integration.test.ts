import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import scheduleExtension from "../src/index.js";
import { CronScheduler } from "../src/scheduler.js";
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
  it("finishes a durable model event before the real parent tool/turn becomes idle", async () => {
    const root = path.resolve("tmp/sdk-fixtures"); fs.mkdirSync(root, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(root, "busy-parent-"));
    const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const manager = SessionManager.inMemory(cwd), storage = new CronStorage(cwd);
    const faux = fauxProvider({ provider: "busy-parent-fixture" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold_parent", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("CHILD_FINISHED_WHILE_PARENT_BUSY"),
      fauxAssistantMessage("PARENT_FINISHED_NORMALLY"),
    ]);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey("busy-parent-fixture", "synthetic-only"); await runtime.getAvailable();
    const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
    storage.addJob({ id: "child", name: "child", type: "event", schedule: "local:fixture", prompt: "Synthetic child, no tools",
      enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: manager.getSessionId(),
      model: "busy-parent-fixture/" + faux.getModel().id, durable: true, deadlineMs: 10_000, maxRuns: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    let scheduler: CronScheduler | undefined, observedBusy = false;
    const errors: string[] = [];
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.on("session_start", (_event, ctx) => { scheduler = new CronScheduler(storage, pi, ctx); scheduler.start(); });
        pi.on("session_shutdown", () => { scheduler?.stop(); });
        pi.registerTool({ name: "hold_parent", label: "Synthetic parent barrier", description: "Synthetic fixture only", parameters: Type.Object({}),
          async execute(_id, _args, _signal, _update, ctx) {
            expect(ctx.isIdle()).toBe(false);
            scheduler!.receiveEvent("child", "local:fixture", "one");
            await vi.waitFor(() => expect(storage.getJob("child")?.lastStatus).toBe("success"), { timeout: 3000 });
            observedBusy = !ctx.isIdle();
            expect(observedBusy).toBe(true);
            expect(storage.getJob("child")).toMatchObject({ attemptCount: 1, runCount: 1, claim: { phase: "settled", outcome: "success" } });
            return { content: [{ type: "text", text: "Parent barrier released after child closure" }], details: {} };
          } });
      }] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", tools: ["hold_parent"], settingsManager: settings, sessionManager: manager, resourceLoader: loader });
    try {
      await session.bindExtensions({ mode: "rpc", onError: error => { errors.push(error.message); } });
      await session.prompt("Synthetic parent task"); await session.waitForIdle();
      expect(observedBusy).toBe(true);
      expect(session.getLastAssistantText(), JSON.stringify({ calls: faux.state.callCount, messages: session.messages.map(message => ({ role: message.role, ...("stopReason" in message ? { stopReason: message.stopReason, errorMessage: message.errorMessage } : {}) })) })).toBe("PARENT_FINISHED_NORMALLY");
      expect(faux.state.callCount).toBe(3); expect(errors).toEqual([]);
      expect(session.messages.filter(message => message.role === "user")).toHaveLength(1);
      expect(storage.getJob("child")?.attemptCount).toBe(1);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); vi.unstubAllEnvs();
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
      await runtime.setRuntimeApiKey("schedule-model-fixture", "synthetic-fixture-only");
      await runtime.getAvailable();
      const result = await runSubagentOnce({ cwd, modelRegistry: new ModelRegistry(runtime), thinkingLevel: "off" } as any,
        "Reply MODEL_FIXTURE_OK without tools", "schedule-model-fixture/" + faux.getModel().id);
      expect(result).toEqual({ ok: true, text: "MODEL_FIXTURE_OK" });
      expect(faux.state.callCount).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

});
