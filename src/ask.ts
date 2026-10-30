import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const OTHER = "✏️  Other answer…";

/** Pick one option or type a different answer; undefined when the user cancels. */
export async function selectOrType(ctx: any, title: string, options: string[]): Promise<string | undefined> {
  const answer = await ctx.ui.select(title, [...options, OTHER]);
  return answer === OTHER ? ctx.ui.input(title) : answer;
}

const Question = Type.Object({
  question: Type.String({ description: "One concrete question" }),
  options: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 4, description: "2-4 answers; put the recommended one first. Leave out for an open question the user answers in their own words" })),
});

/** Batched questions to the user, multiple-choice or open. Shared by setup and, later, the decision gate. */
export function registerAskUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user up to 5 questions at once, each with 2-4 options (recommended first), or open (no options) for an answer in their own words. The user can always write a different answer. Ask only what the code and docs cannot answer.",
    parameters: Type.Object({ questions: Type.Array(Question, { minItems: 1, maxItems: 5 }) }),
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_id, { questions }, _signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("No interactive UI: record these as open questions in the docs instead.");
      const answers: { question: string; answer: string }[] = [];
      for (const [i, q] of questions.entries()) {
        const title = `(${i + 1}/${questions.length}) ${q.question}`;
        const answer = q.options ? await selectOrType(ctx, title, q.options) : await ctx.ui.input(title);
        if (answer === undefined) break;
        answers.push({ question: q.question, answer });
      }
      const skipped = questions.length - answers.length;
      const text = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
      return {
        content: [{ type: "text", text: `${text || "No answers."}${skipped ? `\n\n${skipped} question(s) skipped by the user: keep them as open questions.` : ""}` }],
        details: { answers },
      };
    },
  });
}
