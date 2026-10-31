/**
 * Scheduled prompts are unattended custom turns. Interactive question tools
 * cannot be left open inside a durable claim: the host deadline would expire
 * while the tool waits, and the claim would be settled as UNKNOWN.
 */
export const SCHEDULED_INPUT_BLOCK_REASON =
  "No question was shown and no answer was obtained. This unattended scheduled round cannot wait for interactive input. Save completed work and report the exact missing input as a local blocker in your final response. Continue only independent, already-authorized work; do not repeat this question, guess an answer, claim business completion, or replay earlier effects. Finish this round normally with the unresolved item awaiting user input.";

export function scheduledToolCallBlock(
  scheduledTurn: boolean,
  toolName: string,
): { block: true; reason: string } | undefined {
  if (!scheduledTurn || toolName !== "ask_user_question") return undefined;
  return { block: true, reason: SCHEDULED_INPUT_BLOCK_REASON };
}
