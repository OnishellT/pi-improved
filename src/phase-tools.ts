import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readManifest } from "./manifest.ts";
import { readTask } from "./task-state.ts";

/** Phase tools the model sees only while their phase is active, so a cheap model can't call the wrong one. */
export async function phaseTools(cwd: string) {
  const manifest = await readManifest(cwd).catch(() => undefined);
  const task = await readTask(cwd).catch(() => undefined);
  return { setup_finish: manifest?.setup === "running", task_plan: task?.status === "planning" };
}

export function registerPhaseTools(pi: ExtensionAPI) {
  const sync = async (ctx: ExtensionContext): Promise<void> => {
    const wanted = await phaseTools(ctx.cwd);
    const current = pi.getActiveTools();
    const active = new Set(current);
    for (const [name, on] of Object.entries(wanted)) on ? active.add(name) : active.delete(name);
    // Changing the declared tools can cost the provider's prompt cache: only touch them when the phase changes.
    if (active.size !== current.length || current.some((t) => !active.has(t))) pi.setActiveTools([...active]);
  };
  pi.on("session_start", async (_event, ctx) => void (await sync(ctx)));
  pi.on("before_agent_start", async (_event, ctx) => void (await sync(ctx)));
  pi.on("turn_end", async (_event, ctx) => void (await sync(ctx)));
}
