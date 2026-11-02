import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { globalPath, isObject, updateGlobal } from "./config.ts";
import { globalMap, MANIFEST_PATH, patchMap, readManifest, readProjectManifest, updateManifest, type PhaseModels } from "./manifest.ts";

/** Each phase: its key, its row in /models, what an unset value means, and the option that unsets it. Review has no session fallback: unset means no diff review. */
const PHASES = [
  ["setup", "Setup", "session model", "Use the session model"],
  ["implement", "Implement (plan and code)", "session model", "Use the session model"],
  ["review", "Review and plan check (no model: no review)", "off", "Off: no diff review (the plan check uses the setup model)"],
  ["escalate", "Escalate (when verify keeps failing)", "review model, else setup model", "Unset: use the review model, else the setup model"],
] as const satisfies readonly (readonly [keyof PhaseModels, string, string, string])[];
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
async function pickModel(ctx: ExtensionContext, label: string, unset: string, ids: string[]): Promise<string | null | undefined> {
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
    description: "Pick the model per phase (setup, implement, review, escalate); saved for all projects unless the project file sets that phase; `/models project` for this project only",
    handler: async (args, ctx) => {
      const root = ctx.cwd;
      const scope = args.trim();
      if (scope && scope !== "project") return ctx.ui.notify(`Unknown argument "${scope}". Run /models, or /models project for this project only.`, "error");
      const projectOnly = scope === "project";
      const current = (await readManifest(root)).models ?? {};
      const available = ctx.modelRegistry?.getAvailable().map(idOf).sort() ?? [];
      if (!available.length) return ctx.ui.notify("No models available. Log in with /login.", "error");

      const next: PhaseModels = { ...current };
      for (;;) {
        const lines = rows(next);
        const row = await ctx.ui.select("Which phase to change?", [...lines, DONE]);
        if (!row) return ctx.ui.notify("Models: nothing saved.", "info");
        if (row === DONE) break;
        const [key, name, , unset] = PHASES[lines.indexOf(row)];
        const pick = await pickModel(ctx, name, unset, available);
        if (pick === null) delete next[key];
        else if (pick) next[key] = pick;
      }
      const changed = PHASES.map(([key]) => key).filter((key) => next[key] !== current[key]);
      if (!changed.length) return ctx.ui.notify("Models: no changes.", "info");

      // A phase the project file sets is changed there (it wins over the global file); the rest goes to the global file, unless asked for this project only.
      // A project `models: null` hides the whole global map, so everything goes to the project file, which then sets every other phase to null, so a phase added to the global file later stays hidden too.
      const own = (await readProjectManifest(root)).models;
      const hidden = own === null;
      const inProject = changed.filter((key) => projectOnly || hidden || Object.hasOwn(own ?? {}, key));
      const inGlobal = changed.filter((key) => !inProject.includes(key));
      const only = (models: PhaseModels, keys: (keyof PhaseModels)[]) => Object.fromEntries(keys.filter((k) => models[k] !== undefined).map((k) => [k, models[k]])) as PhaseModels;
      const saved: string[] = [];
      const failed: string[] = [];
      const save = async (file: string, write: () => unknown) => {
        try {
          await write();
          saved.push(file);
        } catch (error: any) {
          failed.push(`${file}: ${error.message}`);
        }
      };
      if (inGlobal.length)
        await save(globalPath(), () =>
          updateGlobal((c) => {
            const models: Record<string, unknown> = isObject(c.models) ? { ...c.models } : {};
            for (const key of inGlobal) next[key] === undefined ? delete models[key] : (models[key] = next[key]);
            if (Object.keys(models).length) c.models = models;
            else delete c.models;
          }),
        );
      if (inProject.length)
        await save(MANIFEST_PATH, () =>
          updateManifest(root, (m) => {
            const inherited = globalMap("models");
            const models = hidden
              ? (Object.fromEntries(PHASES.map(([k]): [string, string | null] => [k, next[k] ?? null])) as PhaseModels)
              : patchMap(m.models ?? undefined, only(current, inProject), only(next, inProject), inherited);
            if (models && Object.keys(models).length) m.models = models;
            else delete m.models;
          }),
        );
      const result = [saved.length ? `Saved in ${saved.join(" and ")}.` : "", failed.length ? `Not saved in ${failed.join("; ")}. Fix the file and run /models again.` : ""].filter(Boolean).join(" ");
      ctx.ui.notify(saved.length ? `${rows(next).join("\n")}\n${result}` : result, failed.length ? "error" : "info");
    },
  });
}
