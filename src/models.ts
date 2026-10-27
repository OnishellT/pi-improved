import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readManifest, updateManifest, type PhaseModels } from "./manifest.ts";

const PHASES = [
  ["setup", "Setup"],
  ["implement", "Implement"],
  ["review", "Review"],
  ["escalate", "When verify gets stuck"],
] as const satisfies readonly (readonly [keyof PhaseModels, string])[];
const SESSION = "Use the session model";
const KEEP = "No changes";
const MAX_FLAT = 15;

const idOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/** The registered, available model for "provider/id", or undefined. */
function resolve(ctx: ExtensionContext, wanted: string) {
  const registry = ctx.modelRegistry;
  const slash = wanted.indexOf("/");
  const model = registry && slash > 0 ? registry.find(wanted.slice(0, slash), wanted.slice(slash + 1)) : undefined;
  return model && registry!.getAvailable().some((m) => idOf(m) === wanted) ? model : undefined;
}

/** Switches to the model configured for the phase. Returns the previous model id, or undefined when nothing changed. */
export async function usePhaseModel(pi: ExtensionAPI, ctx: ExtensionContext, phase: "setup" | "implement"): Promise<string | undefined> {
  try {
    const wanted = (await readManifest(ctx.cwd)).models?.[phase];
    const registry = ctx.modelRegistry;
    if (!wanted || !registry) return undefined;
    const current = ctx.model;
    if (current && idOf(current) === wanted) return undefined;
    const model = resolve(ctx, wanted);
    if (!model) {
      ctx.ui.notify(`Model for ${phase}: ${wanted} is not available (not logged in?). Continuing with the current model.`, "warning");
      return undefined;
    }
    if (!(await pi.setModel(model))) {
      ctx.ui.notify(`Could not switch to ${wanted}. Continuing with the current model.`, "warning");
      return undefined;
    }
    ctx.ui.notify(`Model for ${phase}: ${wanted}`, "info");
    return current ? idOf(current) : undefined;
  } catch (error: any) {
    ctx.ui.notify(`Could not pick the model for ${phase}: ${error.message}`, "warning");
    return undefined;
  }
}

/** Switches to `wanted` (provider/id) quietly. Returns the previous model id and the target, or undefined when nothing changed. Never throws. */
export async function switchModel(pi: ExtensionAPI, ctx: ExtensionContext, wanted: string | undefined): Promise<{ previous: string | undefined; model: string } | undefined> {
  try {
    const registry = ctx.modelRegistry;
    if (!wanted || !registry || (ctx.model && idOf(ctx.model) === wanted)) return undefined;
    const model = resolve(ctx, wanted);
    if (!model) return undefined;
    const previous = ctx.model ? idOf(ctx.model) : undefined;
    return (await pi.setModel(model)) ? { previous, model: wanted } : undefined;
  } catch {
    return undefined;
  }
}

export async function restoreModel(pi: ExtensionAPI, ctx: ExtensionContext, id: string | undefined) {
  if (!id || !ctx.modelRegistry) return;
  const slash = id.indexOf("/");
  const model = ctx.modelRegistry.find(id.slice(0, slash), id.slice(slash + 1));
  if (model) await pi.setModel(model).catch(() => false);
}

async function pickModel(ctx: ExtensionContext, label: string, ids: string[]) {
  let list = ids;
  if (ids.length > MAX_FLAT) {
    const providers = [...new Set(ids.map((id) => id.split("/")[0]))];
    const provider = await ctx.ui.select(`${label}: which provider?`, [KEEP, SESSION, ...providers]);
    if (!provider || provider === KEEP || provider === SESSION) return provider;
    list = ids.filter((id) => id.startsWith(`${provider}/`));
  }
  return ctx.ui.select(`${label}: which model?`, [KEEP, SESSION, ...list]);
}

export function registerModels(pi: ExtensionAPI) {
  pi.registerCommand("models", {
    description: "Pick the model for each phase: setup, implement, review and escalate",
    handler: async (_args, ctx) => {
      const root = ctx.cwd;
      const current = (await readManifest(root)).models ?? {};
      const available = ctx.modelRegistry?.getAvailable().map(idOf).sort() ?? [];
      if (!available.length) return ctx.ui.notify("No models available. Log in with /login.", "error");
      const summary = PHASES.map(([key, name]) => `${name}: ${current[key] ?? "session model"}`).join("\n");
      ctx.ui.notify(summary, "info");

      const next: PhaseModels = { ...current };
      for (const [key, name] of PHASES) {
        const pick = await pickModel(ctx, `${name} (now: ${current[key] ?? "session model"})`, available);
        if (!pick || pick === KEEP) continue;
        if (pick === SESSION) delete next[key];
        else next[key] = pick;
      }
      await updateManifest(root, (m) => {
        if (Object.keys(next).length) m.models = next;
        else delete m.models;
      });
      ctx.ui.notify(PHASES.map(([key, name]) => `${name}: ${next[key] ?? "session model"}`).join("\n"), "info");
    },
  });
}
