import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readManifest, updateManifest, type PhaseModels } from "./manifest.ts";

const PHASES = [
  ["setup", "Setup"],
  ["implement", "Implementación"],
  ["review", "Revisión"],
] as const satisfies readonly (readonly [keyof PhaseModels, string])[];
const SESSION = "Usar el modelo de la sesión";
const KEEP = "Sin cambios";
const MAX_FLAT = 15;

const idOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/** Switches to the model configured for the phase. Returns the previous model id, or undefined when nothing changed. */
export async function usePhaseModel(pi: ExtensionAPI, ctx: ExtensionContext, phase: "setup" | "implement"): Promise<string | undefined> {
  try {
    const wanted = (await readManifest(ctx.cwd)).models?.[phase];
    const registry = ctx.modelRegistry;
    if (!wanted || !registry) return undefined;
    const current = ctx.model;
    if (current && idOf(current) === wanted) return undefined;
    const slash = wanted.indexOf("/");
    const model = slash > 0 ? registry.find(wanted.slice(0, slash), wanted.slice(slash + 1)) : undefined;
    if (!model || !registry.getAvailable().some((m) => idOf(m) === wanted)) {
      ctx.ui.notify(`Modelo para ${phase}: ${wanted} no está disponible (¿falta iniciar sesión?). Sigo con el modelo actual.`, "warning");
      return undefined;
    }
    if (!(await pi.setModel(model))) {
      ctx.ui.notify(`No pude cambiar a ${wanted}. Sigo con el modelo actual.`, "warning");
      return undefined;
    }
    ctx.ui.notify(`Modelo para ${phase}: ${wanted}`, "info");
    return current ? idOf(current) : undefined;
  } catch (error: any) {
    ctx.ui.notify(`No pude elegir el modelo para ${phase}: ${error.message}`, "warning");
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
    const provider = await ctx.ui.select(`${label}: ¿de qué proveedor?`, [KEEP, SESSION, ...providers]);
    if (!provider || provider === KEEP || provider === SESSION) return provider;
    list = ids.filter((id) => id.startsWith(`${provider}/`));
  }
  return ctx.ui.select(`${label}: ¿qué modelo?`, [KEEP, SESSION, ...list]);
}

export function registerModels(pi: ExtensionAPI) {
  pi.registerCommand("models", {
    description: "Elige el modelo de cada fase: setup, implementación y revisión",
    handler: async (_args, ctx) => {
      const root = ctx.cwd;
      const current = (await readManifest(root)).models ?? {};
      const available = ctx.modelRegistry?.getAvailable().map(idOf).sort() ?? [];
      if (!available.length) return ctx.ui.notify("No hay modelos disponibles. Inicia sesión con /login.", "error");
      const summary = PHASES.map(([key, name]) => `${name}: ${current[key] ?? "modelo de la sesión"}`).join("\n");
      ctx.ui.notify(summary, "info");

      const next: PhaseModels = { ...current };
      for (const [key, name] of PHASES) {
        const pick = await pickModel(ctx, `${name} (ahora: ${current[key] ?? "modelo de la sesión"})`, available);
        if (!pick || pick === KEEP) continue;
        if (pick === SESSION) delete next[key];
        else next[key] = pick;
      }
      await updateManifest(root, (m) => {
        if (Object.keys(next).length) m.models = next;
        else delete m.models;
      });
      ctx.ui.notify(PHASES.map(([key, name]) => `${name}: ${next[key] ?? "modelo de la sesión"}`).join("\n"), "info");
    },
  });
}
