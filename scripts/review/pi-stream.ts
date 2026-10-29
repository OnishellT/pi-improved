// Parses the JSON event stream of `pi --mode json`: the answer is the text of the last
// assistant message; usage and cost are summed over all assistant messages.

export interface PiUsage {
  tokens: number;
  costUsd: number;
}

export interface PiAnswer {
  text: string;
  usage: PiUsage;
}

interface AssistantMessage {
  role?: string;
  content?: { type?: string; text?: string }[];
  usage?: { totalTokens?: number; cost?: { total?: number } };
}

export function parsePiStream(stream: string): PiAnswer {
  let text = "";
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
    usage.tokens += message.usage?.totalTokens ?? 0;
    usage.costUsd += message.usage?.cost?.total ?? 0;
  }
  return { text, usage };
}
