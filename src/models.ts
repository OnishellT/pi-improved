import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { globalPath, isObject, updateGlobal } from "./config.ts";
import { globalMap, MANIFEST_PATH, patchMap, readManifest, readProjectManifest, updateManifest, type PhaseModels } from "./manifest.ts";

/** Each phase: its key, its row in /models, and what an unset value means. Review has no session fallback: unset means no review and no plan check. */
const PHASES = [
  ["setup", "Setup", "session model"],
  ["implement", "Implement (plan and code)", "session model"],
  ["review", "Review and plan check (no model: no review)", "off"],
  ["escalate", "Escalate (when verify keeps failing)", "review model, else setup model"],
] as const satisfies readonly (readonly [keyof PhaseModels, string, string])[];
const SESSION = "Use the session model";
const OFF = "Off: no review and no plan check";
const DONE = "Done";
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

/** The model picked for a phase, `null` to unset it, or undefined on Esc (back to the phase list). */
async function pickModel(ctx: ExtensionContext, key: keyof PhaseModels, label: string, ids: string[]): Promise<string | null | undefined> {
  const unset = key === "review" ? OFF : SESSION;
  let list = ids;
  if (ids.length > MAX_FLAT) {
    const providers = [...new Set(ids.map((id) => id.split("/")[0]))];
    const provider = await ctx.ui.select(`${label}: which provider?`, [unset, ...providers]);
    if (!provider || provider === unset) return provider ? null : undefined;
    list = ids.filter((id) => id.startsWith(`${provider}/`));
  }
  const pick = await ctx.ui.select(`${label}: which model?`, [unset, ...list]);
  return pick === unset ? null : (pick ?? undefined);
}

const rows = (models: PhaseModels) => PHASES.map(([key, name, unset]) => `${name}: ${models[key] ?? unset}`);

export function registerModels(pi: ExtensionAPI) {
  pi.registerCommand("models", {
    description: "Pick the model per phase (setup, implement, review, escalate); saved for all projects, `/models project` for this project only",
    handler: async (args, ctx) => {
      const root = ctx.cwd;
      const projectOnly = args.trim() === "project";
      const current = (await readManifest(root)).models ?? {};
      const available = ctx.modelRegistry?.getAvailable().map(idOf).sort() ?? [];
      if (!available.length) return ctx.ui.notify("No models available. Log in with /login.", "error");

      const next: PhaseModels = { ...current };
      for (;;) {
        const lines = rows(next);
        const row = await ctx.ui.select("Which phase to change?", [...lines, DONE]);
        if (!row) return ctx.ui.notify("Models: nothing saved.", "info");
        if (row === DONE) break;
        const [key, name] = PHASES[lines.indexOf(row)];
        const pick = await pickModel(ctx, key, name, available);
        if (pick === null) delete next[key];
        else if (pick) next[key] = pick;
      }
      const changed = PHASES.map(([key]) => key).filter((key) => next[key] !== current[key]);
      if (!changed.length) return ctx.ui.notify("Models: no changes.", "info");

      // A phase the project file sets is changed there (it wins over the global file); the rest goes to the global file, unless asked for this project only.
      const own = (await readProjectManifest(root)).models ?? {};
      const inProject = changed.filter((key) => projectOnly || Object.hasOwn(own, key));
      const inGlobal = changed.filter((key) => !inProject.includes(key));
      const pick = (models: PhaseModels, keys: (keyof PhaseModels)[]) => Object.fromEntries(keys.filter((k) => models[k] !== undefined).map((k) => [k, models[k]])) as PhaseModels;
      try {
        if (inGlobal.length)
          updateGlobal((c) => {
            const models: Record<string, unknown> = isObject(c.models) ? { ...c.models } : {};
            for (const key of inGlobal) next[key] === undefined ? delete models[key] : (models[key] = next[key]);
            if (Object.keys(models).length) c.models = models;
            else delete c.models;
          });
        if (inProject.length)
          await updateManifest(root, (m) => {
            const models = patchMap(m.models, pick(current, inProject), pick(next, inProject), globalMap("models"));
            if (models) m.models = models;
            else delete m.models;
          });
      } catch (error: any) {
        return ctx.ui.notify(`Models not saved: ${error.message}. Fix the file and run /models again.`, "error");
      }
      const where = [inGlobal.length ? globalPath() : "", inProject.length ? MANIFEST_PATH : ""].filter(Boolean).join(" and ");
      ctx.ui.notify(`${rows(next).join("\n")}\nSaved in ${where}.`, "info");
    },
  });
}
