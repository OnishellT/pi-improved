import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readManifest } from "./manifest.ts";

export const DEFAULT_CONTEXT_WARN = 150_000;

/** Tokens at which to warn; 0 or a negative number turns the notice off. */
export const warnThreshold = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_CONTEXT_WARN);

/** Every turn re-reads the whole context, so a big one makes each later turn dearer. Warns once, and again only after the context shrank below the limit. */
export function registerContextGuard(pi: ExtensionAPI) {
  let warned = false;
  pi.on("turn_end", async (_event, ctx) => {
    const tokens = ctx.getContextUsage?.()?.tokens;
    if (typeof tokens !== "number") return;
    const limit = warnThreshold((await readManifest(ctx.cwd).catch(() => undefined))?.contextWarn);
    if (limit <= 0 || tokens < limit) {
      warned = false;
      return;
    }
    if (warned) return;
    warned = true;
    ctx.ui.notify(`The context is ${Math.round(tokens / 1000)}k tokens and every turn re-reads it. Run /compact, or start a new session if the topic changed.`, "warning");
  });
}
