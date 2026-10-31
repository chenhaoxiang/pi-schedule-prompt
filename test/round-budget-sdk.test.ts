import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import schedule from "../src/index.js";
import { CronStorage } from "../src/storage.js";

// Real SDK, faux inference and synthetic tools only. No host credentials/history/network.
it("winds down at the real tool boundary and settles before the unchanged hard deadline", async () => {
  const base = path.resolve("tmp/round-budget-sdk"); fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, "case-"));
  const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir);
  const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  const storage = new CronStorage(cwd);
  storage.addJob({ id: "budget", name: "budget", type: "once", schedule: new Date(Date.now() + 300).toISOString(), prompt: "Complete one synthetic slice", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: manager.getSessionId(), durable: true, maxRuns: 1, deadlineMs: 3000 });
  const publish = vi.fn(async () => ({ content: [{ type: "text" as const, text: "MUST_NOT_EXECUTE" }], details: undefined }));
  const first = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); return { content: [{ type: "text" as const, text: "CHECKPOINT_SAVED" }], details: undefined }; });
  const faux = fauxProvider({ provider: "round-budget-fixture" });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("synthetic_slice", {}, { id: "slice" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("synthetic_publish", {}, { id: "publish" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("ROUND_FINISHED; checkpoint retained; external publish was not attempted"),
  ]);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [schedule] });
  await loader.reload();
  const customTools = [
    { name: "synthetic_slice", label: "Synthetic slice", description: "Synthetic slice", parameters: Type.Object({}), execute: first },
    { name: "synthetic_publish", label: "Synthetic publish", description: "Synthetic publish", parameters: Type.Object({}), execute: publish },
  ];
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", tools: ["synthetic_slice", "synthetic_publish"], customTools, sessionManager: manager, settingsManager: settings, resourceLoader: loader });
  const errors: string[] = [];
  try {
    await session.bindExtensions({ mode: "rpc", onError: error => { errors.push(error.message); } });
    await vi.waitFor(() => expect(storage.getJob("budget")?.claim?.phase).toBe("settled"), { timeout: 7000 });
    await session.waitForIdle();
    expect(first).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled();
    expect(storage.getJob("budget")).toMatchObject({ deadlineMs: 3000, attemptCount: 1, claim: { phase: "settled", outcome: "success" } });
    const entries = manager.getEntries();
    expect(entries.filter(entry => entry.type === "custom" && entry.customType === "schedule_wind_down")).toHaveLength(1);
    expect(entries.filter(entry => entry.type === "custom_message" && entry.customType === "schedule_budget")).toHaveLength(0);
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(0);
    const blocked = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "synthetic_publish") as any;
    expect(blocked?.message.isError).toBe(true); expect(blocked?.message.content[0].text).toContain("was NOT executed");
    expect(faux.state.callCount).toBe(3); expect(errors).toEqual([]);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); fs.rmSync(cwd, { recursive: true, force: true });
  }
}, 10_000);
