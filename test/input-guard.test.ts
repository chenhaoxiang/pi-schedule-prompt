import { describe, expect, it } from "vitest";
import { SCHEDULED_INPUT_BLOCK_REASON, scheduledToolCallBlock } from "../src/input-guard.js";

describe("scheduled interactive-input guard", () => {
  it("blocks ask_user_question only during a scheduled turn", () => {
    expect(scheduledToolCallBlock(true, "ask_user_question")).toEqual({ block: true, reason: SCHEDULED_INPUT_BLOCK_REASON });
    expect(scheduledToolCallBlock(false, "ask_user_question")).toBeUndefined();
  });

  it("does not block unrelated tools", () => {
    expect(scheduledToolCallBlock(true, "read")).toBeUndefined();
    expect(scheduledToolCallBlock(false, "read")).toBeUndefined();
  });
});
