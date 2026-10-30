/**
 * Lightweight in-process subagent runner.
 *
 * Used when a scheduled job has `model` set: spawn a fresh AgentSession with
 * the chosen model, run the prompt to completion, return the assistant's text.
 * No subprocess, no extension recursion (noExtensions: true), no persistence.
 */

import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"];

export type SubagentResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export interface RunSubagentOptions {
  /** If true, load all extensions. If an array, only those named. Default undefined (none). */
  extensions?: boolean | string[];
  /** If true, load all skills. If an array, only those named. Default undefined (none). */
  skills?: boolean | string[];
}

export type ModelResolution =
  | { ok: true; model: Model<any>; route: string }
  | { ok: false; error: string };

const modelRoute = (model: Model<any>): string => `${model.provider}/${model.id}`;

function ambiguousModelError(requested: string, candidates: Model<any>[]): string {
  const matches = [...new Set(candidates.map(modelRoute))].sort((a, b) => a.localeCompare(b));
  return `Model '${requested}' is ambiguous. Use a full provider/model route. Matches: ${matches.join(", ")}`;
}

/**
 * Resolve a scheduled model only against the host's currently available
 * (authenticated) registry and return its canonical provider/id route.
 *
 * Bare ids and the historical fuzzy aliases remain supported for compatibility,
 * but an ambiguous match is rejected instead of being selected by registry
 * order. Persisting the canonical route prevents a later execution from
 * choosing a different provider for the same model id.
 */
export function resolveModelRoute(
  registry: ExtensionContext["modelRegistry"],
  modelStr: string,
): ModelResolution {
  const requested = modelStr.trim();
  if (!requested) return { ok: false, error: "Model must be a non-empty string" };

  let needle = requested;
  let providerHint: string | undefined;
  const slash = requested.indexOf("/");
  if (slash !== -1) {
    providerHint = requested.slice(0, slash).trim();
    needle = requested.slice(slash + 1).trim();
  }
  if (!needle || (slash !== -1 && !providerHint)) {
    return { ok: false, error: `Invalid model route '${modelStr}'. Use provider/model-id.` };
  }

  const candidates = registry.getAvailable().filter((model) =>
    !providerHint || model.provider.toLowerCase() === providerHint.toLowerCase(),
  );
  const lowerNeedle = needle.toLowerCase();
  const exact = candidates.filter((model) => model.id.toLowerCase() === lowerNeedle);
  if (exact.length === 1) return { ok: true, model: exact[0], route: modelRoute(exact[0]) };
  if (exact.length > 1) return { ok: false, error: ambiguousModelError(modelStr, exact) };

  const idMatches = candidates.filter((model) => model.id.toLowerCase().includes(lowerNeedle));
  if (idMatches.length === 1) return { ok: true, model: idMatches[0], route: modelRoute(idMatches[0]) };
  if (idMatches.length > 1) return { ok: false, error: ambiguousModelError(modelStr, idMatches) };

  const nameMatches = candidates.filter((model) => model.name.toLowerCase().includes(lowerNeedle));
  if (nameMatches.length === 1) return { ok: true, model: nameMatches[0], route: modelRoute(nameMatches[0]) };
  if (nameMatches.length > 1) return { ok: false, error: ambiguousModelError(modelStr, nameMatches) };

  return {
    ok: false,
    error: `Unknown model '${modelStr}'. ${describeAvailableModels(registry)}`,
  };
}

export function resolveModel(
  registry: ExtensionContext["modelRegistry"],
  modelStr: string,
): Model<any> | undefined {
  const result = resolveModelRoute(registry, modelStr);
  return result.ok ? result.model : undefined;
}

export function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const parts: string[] = [];
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c && typeof c === "object" && (c as any).type === "text" && (c as any).text) {
          parts.push((c as any).text);
        }
      }
    }
    const text = parts.join("").trim();
    if (text) return text;
  }
  return "";
}

export function describeAvailableModels(
  registry: ExtensionContext["modelRegistry"],
): string {
  const available = registry.getAvailable();
  if (available.length === 0) return "No models with configured auth.";
  const sample = available.slice(0, 5).map((m) => `${m.provider}/${m.id}`).join(", ");
  const more = available.length > 5 ? `, … (${available.length - 5} more)` : "";
  return `Available: ${sample}${more}`;
}

export async function runSubagentOnce(
  ctx: ExtensionContext,
  prompt: string,
  modelStr: string,
  signal?: AbortSignal,
  options: RunSubagentOptions = {},
): Promise<SubagentResult> {
  try {
    const resolution = resolveModelRoute(ctx.modelRegistry, modelStr);
    if (!resolution.ok) return { ok: false, error: resolution.error };
    const { model } = resolution;

    if (signal?.aborted) return { ok: false, error: "Scheduled model run was aborted" };
    const agentDir = getAgentDir();

    // Helper: convert extensions/skills option to boolean and optionally filter.
    // An empty array means "none" — same as unset.
    const isEnabled = (v: boolean | string[] | undefined): boolean =>
      v === true || (Array.isArray(v) && v.length > 0);
    const getNameList = (v: boolean | string[] | undefined): string[] | undefined =>
      Array.isArray(v) && v.length > 0 ? v : undefined;

    const extList = getNameList(options.extensions);
    const skillList = getNameList(options.skills);

    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      // Prevent recursive loading of this extension into the subagent.
      // Context files (AGENTS.md / CLAUDE.md) are loaded by defaults.
      noExtensions: !isEnabled(options.extensions),
      noSkills: !isEnabled(options.skills),
      noPromptTemplates: true,
      noThemes: true,
      ...(isEnabled(options.extensions) && {
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((ext) =>
            !ext.path.startsWith(packageRoot) &&
            (!extList || extList.some((name) => ext.path.toLowerCase().includes(name.toLowerCase()))),
          ),
        }),
      }),
      ...(skillList && {
        skillsOverride: (base) => ({
          ...base,
          skills: base.skills.filter((skill) =>
            skillList.includes(skill.name || ""),
          ),
        }),
      }),
    });
    await loader.reload();

    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    const native = ctx.modelRegistry.getRegisteredNativeProvider?.(model.provider);
    const configured = ctx.modelRegistry.getRegisteredProviderConfig?.(model.provider);
    if (native) modelRuntime.registerNativeProvider(native);
    else if (configured) modelRuntime.registerProvider(model.provider, configured);
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager: SettingsManager.create(ctx.cwd, agentDir),
      modelRuntime,
      thinkingLevel: ctx.thinkingLevel,
      model,
      tools: isEnabled(options.extensions) ? undefined : DEFAULT_TOOL_NAMES,
      resourceLoader: loader,
    });

    try {
    if (isEnabled(options.extensions)) {
      await session.bindExtensions({});
    }
    let onAbort: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        session.abort();
      } else {
        onAbort = () => session.abort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let buffered = "";
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_start") {
        buffered = "";
      } else if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        buffered += event.assistantMessageEvent.delta;
      }
    });

    try {
      await session.prompt(prompt);
    } finally {
      unsubscribe();
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    if (signal?.aborted) return { ok: false, error: "Scheduled model run was aborted" };
    const last = session.messages.filter(message => message.role === "assistant").at(-1);
    if (last?.stopReason === "error" || last?.stopReason === "aborted") {
      return { ok: false, error: last.errorMessage || "Scheduled model run did not complete" };
    }
    const text = buffered.trim() || getLastAssistantText(session);
    return { ok: true, text };
    } finally {
      try { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { session.dispose(); }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
