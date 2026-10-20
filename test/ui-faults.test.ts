import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronStorage } from "../src/storage.js";
import { CronWidget } from "../src/ui/cron-widget.js";
import { JobsView } from "../src/ui/jobs-view.js";

const owned: string[] = [];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function fixture() {
  const root = path.resolve("tmp/ui-fault-fixtures");
  fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, "case-"));
  owned.push(cwd);
  const storage = new CronStorage(cwd);
  storage.addJob({ id: "one", name: "check", schedule: "1h", intervalMs: 3600000, type: "interval",
    enabled: true, prompt: "authorized check", runCount: 0, createdAt: new Date().toISOString() });
  return storage;
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("UI contains a store fault instead of killing the host", () => {
  it("contains a mounted widget's 30-second refresh and render after real JSON corruption", async () => {
    const storage = fixture();
    const ctx = { ui: { setWidget: vi.fn() } };
    const widget = new CronWidget(storage, { getNextRun: () => null } as any,
      { events: { on: () => () => {} } } as any, () => true);
    widget.show(ctx);
    const validBytes = fs.readFileSync(storage.getStorePath(), "utf8");
    fs.writeFileSync(storage.getStorePath(), "corrupt-json");
    try {
      await expect(vi.advanceTimersByTimeAsync(30000)).resolves.toBeDefined();
      const factory = ctx.ui.setWidget.mock.calls.at(-1)![1] as any;
      expect(factory(null, theme).render(100).join("\n")).toContain("unreadable");
      expect(fs.readFileSync(storage.getStorePath(), "utf8")).toBe("corrupt-json");
      fs.writeFileSync(storage.getStorePath(), validBytes);
      await vi.advanceTimersByTimeAsync(30000);
      const recovered = ctx.ui.setWidget.mock.calls.at(-1)![1] as any;
      expect(recovered(null, theme).render(100).join("\n")).not.toContain("unreadable");
    } finally { widget.hide(ctx); widget.destroy(); }
  });

  it("contains the overlay's initial read fault and remains closable", () => {
    const storage = fixture();
    fs.writeFileSync(storage.getStorePath(), "corrupt-json");
    const done = vi.fn();
    const view = new JobsView(storage, {} as any, "owner", async () => {}, theme, () => {}, done);
    expect(view.render(100).join("\n")).toContain("unreadable");
    view.handleInput("q");
    expect(done).toHaveBeenCalledOnce();
  });

  it("contains the asynchronous add-flow refresh fault", async () => {
    const storage = fixture();
    const render = vi.fn();
    const view = new JobsView(storage, {} as any, "owner", async () => {
      fs.writeFileSync(storage.getStorePath(), "corrupt-json");
    }, theme, render, () => {});
    view.handleInput("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(render).toHaveBeenCalledOnce();
    expect(view.render(100).join("\n")).toContain("unreadable");
  });

  it("contains a locked store during a management action without claiming success", () => {
    const storage = fixture();
    const view = new JobsView(storage, { getNextRun: () => null } as any, "owner", async () => {}, theme, () => {}, () => {});
    fs.writeFileSync(`${storage.getStorePath()}.lock`, "other-writer");
    expect(() => view.handleInput("t")).not.toThrow();
    expect(view.render(100).join("\n")).toContain("operation failed");
    expect(storage.getJob("one")?.enabled).toBe(true);
  });
});
