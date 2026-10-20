import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { EVENT_REQUEST } from "../src/events.js";
import schedule from "../src/index.js";
import { CronStorage } from "../src/storage.js";

async function fixture(eventName: string) {
  const base = path.resolve("tmp/event-sdk"); fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, "case-"));
  const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const manager = SessionManager.inMemory(cwd);
  const storage = new CronStorage(cwd);
  storage.addJob({ id: "event", name: "event", type: "event", schedule: eventName, prompt: "Reply EVENT_OK", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: manager.getSessionId(), maxRunsPerDay: 5 });
  const faux = fauxProvider({ provider: "event-sdk-fixture" }); faux.setResponses([fauxAssistantMessage("EVENT_OK")]);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
  let bus!: ExtensionAPI["events"];
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [schedule, pi => { bus = pi.events; }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", tools: [], sessionManager: manager, settingsManager: settings, resourceLoader: loader });
  const errors: string[] = [];
  await session.bindExtensions({ mode: "rpc", onError: error => { errors.push(error.message); } });
  const cleanup = async () => { try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); vi.unstubAllEnvs(); fs.rmSync(cwd, { recursive: true, force: true }); } };
  return { session, faux, storage, bus, cleanup, errors };
}

describe("real SDK event lifecycle", () => {
  it("fires at session-start but never recursively from its own settled turn", async () => {
    const h = await fixture("lifecycle:session-start,lifecycle:agent-settled");
    try {
      await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("EVENT_OK"));
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(h.faux.state.callCount).toBe(1);
      expect(h.storage.getJob("event")?.runCount).toBe(1);
      expect(h.errors).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("rejects arbitrary bus payloads and routes one duplicate-safe local event", async () => {
    const h = await fixture("local:done");
    try {
      const results: unknown[] = [];
      h.bus.on(EVENT_REQUEST + ":result:r1", result => { results.push(result); });
      h.bus.emit(EVENT_REQUEST, { version: 1, requestId: "r1", jobId: "event", eventName: "local:done", eventId: "one", prompt: "injected" });
      expect(results).toEqual([{ status: "ignored", reason: "invalid-request" }]);
      expect(h.faux.state.callCount).toBe(0);
      const request = { version: 1, requestId: "r1", jobId: "event", eventName: "local:done", eventId: "one" };
      h.bus.emit(EVENT_REQUEST, request);
      await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("EVENT_OK"));
      h.bus.emit(EVENT_REQUEST, request);
      expect(results.at(-1)).toEqual({ status: "duplicate" });
      expect(h.faux.state.callCount).toBe(1);
      expect(h.errors).toEqual([]);
    } finally { await h.cleanup(); }
  });
});
