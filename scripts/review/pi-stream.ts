// Parses the JSON event stream of `pi --mode json`: the answer is the text of the last
// assistant message; usage and cost are summed over all assistant messages. A provider error
// ends the run with exit code 0 and an assistant message whose stopReason is "error" and whose
// errorMessage holds the provider's text, so it is read from there.

export interface PiUsage {
  tokens: number;
  costUsd: number;
}

export interface PiAnswer {
  text: string;
  usage: PiUsage;
  // The provider's error text when the last assistant message ended in an error.
  error?: string;
}

interface AssistantMessage {
  role?: string;
  content?: { type?: string; text?: string }[];
  usage?: { totalTokens?: number; cost?: { total?: number } };
  stopReason?: string;
  errorMessage?: string;
}

export function parsePiStream(stream: string): PiAnswer {
  let text = "";
  let error: string | undefined;
  const usage: PiUsage = { tokens: 0, costUsd: 0 };
  for (const line of stream.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: string; message?: AssistantMessage };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = event.message;
    if (event.type !== "message_end" || message?.role !== "assistant") continue;
    text = (message.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("");
    error =
      message.stopReason === "error" || message.stopReason === "aborted"
        ? message.errorMessage?.trim() || `request ${message.stopReason}`
        : undefined;
    usage.tokens += message.usage?.totalTokens ?? 0;
    usage.costUsd += message.usage?.cost?.total ?? 0;
  }
  return error === undefined ? { text, usage } : { text, usage, error };
}

// A subscription, quota or billing limit: it resets in hours, so retrying it only wastes time.
const usageLimit = /usage[ _]limit|quota|billing|out of budget|available balance/i;

export interface RunOutcome {
  code: number;
  err: string;
  // Set when the script killed pi: over the total time, or no event for the idle time.
  killed?: "total" | "idle";
}

export interface RunFailure {
  problem: string;
  retry: boolean;
}

// Why one reviewer run produced no answer, and whether another try can help.
// Undefined means the run gave an answer.
export function runFailure(
  run: RunOutcome,
  answer: PiAnswer,
  limits: { timeoutMs: number; idleMs: number },
): RunFailure | undefined {
  const knobs = `raise REVIEW_TIMEOUT_MS (now ${limits.timeoutMs}) or REVIEW_IDLE_MS (now ${limits.idleMs}) and run again`;
  if (run.killed === "total") {
    // The same limit would stop a second try at the same point.
    return { problem: `stopped after ${Math.round(limits.timeoutMs / 1000)}s in total; ${knobs}`, retry: false };
  }
  if (run.killed === "idle") {
    return { problem: `stopped after no output for ${Math.round(limits.idleMs / 1000)}s; ${knobs}`, retry: true };
  }
  if (answer.error !== undefined) {
    const text = answer.error.replace(/\s+/g, " ").trim().slice(0, 300);
    return usageLimit.test(text)
      ? {
          problem: `provider usage limit: ${text}\nWait for the limit to reset, or pick another reviewer with REVIEW_PROVIDER and REVIEW_MODEL.`,
          retry: false,
        }
      : { problem: `provider error: ${text}`, retry: true };
  }
  if (run.code !== 0) return { problem: `exit ${run.code}: ${run.err.trim().slice(0, 300) || "no error output"}`, retry: true };
  if (answer.text.trim() === "") return { problem: "empty answer", retry: true };
  return undefined;
}
