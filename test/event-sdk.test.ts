import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { EVENT_REQUEST } from "../src/events.js";
import schedule from "../src/index.js";
import { CronStorage } from "../src/storage.js";

async function fixture(eventName: string, ui?: { notify: ReturnType<typeof vi.fn>; setWidget: ReturnType<typeof vi.fn> }, tools: string[] = []) {
  const base = path.resolve("tmp/event-sdk"); fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, "case-"));
  const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  if (ui) {
    vi.stubEnv("SCHEDULE_SYNTHETIC_MISSING_TOKEN", undefined);
    fs.writeFileSync(path.join(agentDir, "schedule-prompts-settings.json"), JSON.stringify({ eventApi: { enabled: true, port: 0, tokenEnv: "SCHEDULE_SYNTHETIC_MISSING_TOKEN" } }));
  }
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
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", tools, sessionManager: manager, settingsManager: settings, resourceLoader: loader });
  const errors: string[] = [];
  await session.bindExtensions({ mode: "rpc", ...(ui ? { uiContext: ui as any } : {}), onError: error => { errors.push(error.message); } });
  const cleanup = async () => { try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); vi.unstubAllEnvs(); fs.rmSync(cwd, { recursive: true, force: true }); } };
  return { session, faux, storage, bus, cleanup, errors, cwd };
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

  it("admits a later startup of the same session as a distinct event", async () => {
    const h = await fixture("lifecycle:session-start");
    try {
      await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("EVENT_OK"));
      await h.session.waitForIdle();
      h.faux.appendResponses([fauxAssistantMessage("RELOAD_OK")]);
      await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("RELOAD_OK"));
      expect(h.faux.state.callCount).toBe(2);
      expect(h.storage.getJob("event")?.runCount).toBe(2);
      expect(h.errors).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("warns visibly on an enabled API startup failure without blocking other event scheduling", async () => {
    const ui = { notify: vi.fn(), setWidget: vi.fn() };
    const h = await fixture("local:done", ui);
    try {
      expect(ui.notify).toHaveBeenCalledWith("Local event API could not start; other scheduling remains available", "warning");
      expect(h.faux.state.callCount).toBe(0);
      h.bus.emit(EVENT_REQUEST, { version: 1, requestId: "r1", jobId: "event", eventName: "local:done", eventId: "one" });
      await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("EVENT_OK"));
      expect(h.errors).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("routes evidence changes through native execution, artifact verification and explicit stop without duplicate wake", async () => {
    const h = await fixture("local:result", undefined, ["read", "write", "schedule_prompt"]);
    try {
      h.storage.updateJob("event", { quietOnNoChange: true, noChangeThreshold: 2, quietForMs: 60_000, maxRuns: 3, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const resultPath = path.join(h.cwd, "result.json");
      const toolText = (messages: Array<{ role: string; [key: string]: unknown }>, id: string) => {
        const result = messages.find(message => message.role === "toolResult" && message.toolCallId === id);
        expect(result).toBeDefined();
        expect(result!.isError).not.toBe(true);
        return result;
      };
      h.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write", { path: resultPath, content: '{"stage":1,"value":4}' }, { id: "write-first" })),
        fauxAssistantMessage(fauxToolCall("read", { path: resultPath }, { id: "verify-first" })),
        context => {
          expect(JSON.stringify(toolText(context.messages as any, "verify-first"))).toContain('\\"value\\":4');
          return fauxAssistantMessage("FIRST_RESULT_VERIFIED");
        },
        fauxAssistantMessage(fauxToolCall("write", { path: resultPath, content: '{"stage":2,"value":9}' }, { id: "write-final" })),
        fauxAssistantMessage(fauxToolCall("read", { path: resultPath }, { id: "verify-final" })),
        context => {
          expect(JSON.stringify(toolText(context.messages as any, "verify-final"))).toContain('\\"value\\":9');
          return fauxAssistantMessage(fauxToolCall("schedule_prompt", { action: "disable", jobId: "event" }, { id: "stop-checks" }));
        },
        fauxAssistantMessage(fauxToolCall("schedule_prompt", { action: "list" }, { id: "readback-stop" })),
        context => {
          const result = toolText(context.messages as any, "readback-stop");
          expect((result!.details as { jobs: Array<{ id: string; enabled: boolean }> }).jobs.find(job => job.id === "event")?.enabled).toBe(false);
          return fauxAssistantMessage("FINAL_RESULT_VERIFIED_AND_STOPPED");
        },
      ]);
      const observed: unknown[] = [];
      h.bus.on(EVENT_REQUEST + ":result:evidence", result => { observed.push(result); });
      const emit = (eventId: string, evidenceFingerprint: string, extra = {}) => h.bus.emit(EVENT_REQUEST,
        { version: 1, requestId: "evidence", jobId: "event", eventName: "local:result", eventId, evidenceFingerprint, ...extra });
      for (const fingerprint of ["", "not-a-hash", "A".repeat(64)]) {
        emit("invalid", fingerprint);
        expect(observed.at(-1)).toEqual({ status: "ignored", reason: "invalid-request" });
      }
      emit("injected", "a".repeat(64), { prompt: "Do not accept arbitrary payload" });
      expect(observed.at(-1)).toEqual({ status: "ignored", reason: "invalid-request" });
      expect(h.faux.state.callCount).toBe(0);
      emit("first", "a".repeat(64));
      expect(observed.at(-1)).toEqual({ status: "queued" });
      await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("FIRST_RESULT_VERIFIED"));
      await h.session.waitForIdle();
      expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toEqual({ stage: 1, value: 4 });
      expect(h.faux.state.callCount).toBe(3);
      for (const id of ["same-new-id-1", "same-new-id-2"]) {
        emit(id, "a".repeat(64));
        expect(observed.at(-1)).toEqual({ status: "duplicate", reason: "no-change" });
      }
      expect(h.storage.getJob("event")).toMatchObject({ lastStatus: "quiet", runCount: 1, noChangeCount: 2 });
      expect(h.faux.state.callCount).toBe(3);
      emit("changed", "b".repeat(64));
      expect(observed.at(-1)).toEqual({ status: "queued" });
      await vi.waitFor(() => expect(h.session.getLastAssistantText()).toBe("FINAL_RESULT_VERIFIED_AND_STOPPED"));
      await h.session.waitForIdle();
      expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toEqual({ stage: 2, value: 9 });
      expect(h.storage.getJob("event")).toMatchObject({ enabled: false, runCount: 2, noChangeCount: 0, lastEvidenceFingerprint: "b".repeat(64) });
      emit("after-stop", "c".repeat(64));
      expect(observed.at(-1)).toEqual({ status: "ignored", reason: "paused" });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(h.faux.state.callCount).toBe(8);
      expect(h.storage.getJob("event")?.pendingEvent).toBeUndefined();
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
