import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import schedule from "../src/index.js";
import { CronStorage } from "../src/storage.js";

async function fixture(scheduled = true) {
  const base = path.resolve("tmp/scheduled-input-sdk"); fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, "case-"));
  const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir);
  const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  const storage = new CronStorage(cwd);
  if (scheduled) storage.addJob({ id: "input", name: "input", type: "once", schedule: new Date(Date.now() + 500).toISOString(), prompt: "Finish independent work; missing email is a local blocker", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: manager.getSessionId(), durable: true, maxRuns: 1, deadlineMs: 1000 });
  const question = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Synthetic answer" }], details: undefined }));
  const faux = fauxProvider({ provider: "scheduled-input-fixture" });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_user_question", {}, { id: "synthetic-question" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("ROUND_FINISHED; missing email remains pending, not business success"),
  ]);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [schedule] });
  await loader.reload();
  const customQuestion = { name: "ask_user_question", label: "Synthetic question", description: "Synthetic question", parameters: Type.Object({}), execute: question };
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", tools: ["ask_user_question"], customTools: [customQuestion], sessionManager: manager, settingsManager: settings, resourceLoader: loader });
  const errors: string[] = [];
  await session.bindExtensions({ mode: "rpc", onError: error => { errors.push(error.message); } });
  const cleanup = async () => { try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); } };
  return { session, manager, storage, question, faux, errors, cleanup };
}

describe("scheduled input through the real Pi tool boundary", () => {
  it("blocks the question before execution and settles the same native claim", async () => {
    const h = await fixture();
    try {
      expect(h.session.getActiveToolNames()).toContain("ask_user_question");
      await vi.waitFor(() => expect(h.session.getLastAssistantText()).toContain("ROUND_FINISHED"));
      await h.session.waitForIdle();
      expect(h.question.mock.calls.length).toBe(0);
      expect(h.storage.getJob("input")).toMatchObject({ attemptCount: 1, runCount: 1, waitingReason: "user_input_required", claim: { phase: "settled", outcome: "success" } });
      const receipt = h.manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "schedule_execution") as any;
      expect(receipt?.data).toMatchObject({ outcome: "success", waitingReason: "user_input_required" });
      const blocked = h.manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult") as any;
      expect(blocked?.message.isError).toBe(true);
      expect(blocked?.message.content[0].text).toContain("No question was shown");
      expect(h.faux.state.callCount).toBe(2);
      expect(h.errors).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("still executes the question tool during an ordinary user turn", async () => {
    const h = await fixture(false);
    try {
      await h.session.prompt("An interactive request");
      await h.session.waitForIdle();
      expect(h.question.mock.calls.length).toBe(1);
      expect(h.manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "schedule_input_required")).toBe(false);
      expect(h.errors).toEqual([]);
    } finally { await h.cleanup(); }
  });
});
