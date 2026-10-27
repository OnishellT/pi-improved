import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readManifest } from "./manifest.ts";
import { clean, listSkills, loadSkill } from "./skills.ts";

export const BASE_LINES = [
  "In reversible work inside a phase, proceed and show the result; ask only before irreversible actions or when the phase requires approval.",
  "Answer short; no recap of what the user just said.",
];

/** Text appended to the main session's system prompt: the unslop skill (when bundled) and the working-style lines. Deterministic. */
export async function basePromptText(): Promise<string> {
  const bundled = await listSkills();
  const parts: string[] = [];
  if (bundled.includes("unslop")) parts.push(`## Skill: unslop\n\n${clean((await loadSkill("unslop")).body, bundled)}`);
  parts.push(BASE_LINES.join("\n"));
  return parts.join("\n\n");
}

/** Main session only: index.ts returns before this runs in a subagent child, and children get their brief through --file. */
export function registerBasePrompt(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    if ((await readManifest(ctx.cwd).catch(() => undefined))?.basePrompt === false) return;
    const text = await basePromptText();
    if (event.systemPrompt.includes(text)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
  });
}
