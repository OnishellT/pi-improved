import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkThresholds, profileForModel, resolveConfig, sanitizeStatus, thresholdState, thresholdTokens } from "./config.ts";
import { loadProfileFile } from "./profile.ts";

export default function (pi: ExtensionAPI) {
  for (const [name, description] of [
    ["compact-notice", "Context percentage/token threshold for the soft notice"],
    ["compact-warning", "Context percentage/token threshold for the warning"],
    ["compact-force", "Context percentage/token threshold for forced compaction"],
    ["compact-buffer", "Context tokens reserved before the model limit"],
    ["compact-prompt", "Custom instructions for compaction summaries"],
  ] as const) {
    pi.registerFlag(name, { type: "string", description });
  }

  const flagOverrides = () => ({
    notice: pi.getFlag("compact-notice"),
    warning: pi.getFlag("compact-warning"),
    force: pi.getFlag("compact-force"),
    buffer: pi.getFlag("compact-buffer"),
    prompt: pi.getFlag("compact-prompt"),
  });
  let config = resolveConfig(); // flags and config files apply at session_start
  let notifiedError: string | undefined;
  let forceFailed = false; // set when a forced compaction errors; cleared once usage leaves the force tier
  let lastTier = "below";
  let compacting = false;
  let activeContextWindow: number | undefined;
  const profilePath = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "self-compact.json");

  const usageFor = (ctx: ExtensionContext, selectedContextWindow?: number) => {
    const usage = ctx.getContextUsage();
    const contextWindow = selectedContextWindow ?? activeContextWindow ?? usage?.contextWindow;
    if (!usage || usage.tokens == null || !contextWindow) return undefined;
    return { ...usage, contextWindow, effectiveWindow: Math.max(1, contextWindow - config.buffer) };
  };

  /** Why thresholds cannot be enforced for this window, or undefined. Notifies once per distinct problem. */
  const configProblem = (ctx: ExtensionContext, effectiveWindow: number) => {
    const error = checkThresholds(config, effectiveWindow);
    if (error && error !== notifiedError && ctx.hasUI) ctx.ui.notify(`Self-compact: ${error}. Enforcement is off.`, "error");
    notifiedError = error;
    return error;
  };

  const installFooter = (ctx: ExtensionContext) => {
    ctx.ui.setWidget("self-compact", undefined);
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width) {
          const usage = usageFor(ctx);
          const contextWindow = usage?.effectiveWindow ?? Math.max(1, (activeContextWindow ?? ctx.model?.contextWindow ?? 0) - config.buffer);
          const tokens = usage?.tokens ?? 0;
          const percent = usage?.tokens == null ? 0 : (tokens / contextWindow) * 100;
          const filled = Math.min(20, Math.round((percent / 100) * 20));
          const bar = `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
          let state = "";
          if (usage?.tokens != null) {
            state = checkThresholds(config, contextWindow) ? "invalid thresholds" : thresholdState(tokens, contextWindow, config);
          }
          const marks = `N ${thresholdTokens(config.notice, contextWindow).toLocaleString()} · W ${thresholdTokens(config.warning, contextWindow).toLocaleString()} · F ${thresholdTokens(config.force, contextWindow).toLocaleString()}`;
          const contextLine = `Context ${bar} ${usage?.tokens == null ? `?/${contextWindow.toLocaleString()}` : `${tokens.toLocaleString()}/${contextWindow.toLocaleString()} (${percent.toFixed(1)}%)`} · ${marks}${state && state !== "below" ? ` · ${state.toUpperCase()}` : ""}`;

          const home = resolve(homedir());
          const cwd = resolve(ctx.cwd);
          const fromHome = relative(home, cwd);
          let path = fromHome === "" ? "~" : fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome) ? `~${sep}${fromHome}` : cwd;
          const branch = footerData.getGitBranch();
          if (branch) path += ` (${branch})`;
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) path += ` • ${sessionName}`;

          let input = 0, output = 0, cost = 0;
          for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const message = entry.message as AssistantMessage;
              input += message.usage.input;
              output += message.usage.output;
              cost += message.usage.cost.total;
            }
          }
          const fmt = (value: number) => value < 1000 ? `${value}` : value < 10_000 ? `${(value / 1000).toFixed(1)}k` : value < 1_000_000 ? `${Math.round(value / 1000)}k` : `${(value / 1_000_000).toFixed(1)}M`;
          const stats = `${input ? `↑${fmt(input)} ` : ""}${output ? `↓${fmt(output)} ` : ""}$${cost.toFixed(3)}`;
          let model = ctx.model?.id ?? "no-model";
          if (ctx.model?.reasoning) model += ` · ${ctx.thinkingLevel ?? "off"}`;
          if (footerData.getAvailableProviderCount() > 1 && ctx.model) model = `(${ctx.model.provider}) ${model}`;
          const pair = (left: string, right: string) => {
            const safeRight = truncateToWidth(right, width, "");
            const available = Math.max(0, width - visibleWidth(safeRight) - 1);
            const safeLeft = truncateToWidth(left, available, "");
            return `${safeLeft}${" ".repeat(Math.max(0, width - visibleWidth(safeLeft) - visibleWidth(safeRight)))}${safeRight}`;
          };
          const lines = [
            theme.fg("dim", pair(path, contextLine)),
            theme.fg("dim", pair(stats, model)),
          ];
          const statuses = [...footerData.getExtensionStatuses().entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => sanitizeStatus(text)).filter(Boolean);
          if (statuses.length) lines.push(truncateToWidth(theme.fg("dim", statuses.join(" ")), width));
          return lines;
        },
      };
    });
  };

  const compact = (ctx: ExtensionContext, note?: string) => {
    if (compacting) return;
    compacting = true;
    ctx.compact({
      customInstructions: [config.prompt, note ? `Agent handoff note:\n${note}` : ""].filter(Boolean).join("\n\n"),
      onComplete: () => { compacting = false; },
      onError: (error) => {
        compacting = false;
        forceFailed = true;
        if (ctx.hasUI) ctx.ui.notify(`Self-compaction failed: ${error.message}`, "error");
      },
    });
  };

  pi.registerTool({
    name: "self_compact",
    label: "Self-compact",
    description: "Compact the conversation now. Add an optional handoff note with the goal, decisions, current state, and next action to preserve across compaction.",
    promptSnippet: "self_compact: preserve progress and continue after context compaction",
    promptGuidelines: ["Use self_compact at a useful stopping point when context is approaching the configured warning threshold. Include a concise handoff note."],
    parameters: Type.Object({ note: Type.Optional(Type.String({ description: "Continuation state to preserve in the compaction summary" })) }),
    execute: async (_id, { note }, _signal, _update, ctx) => {
      const running = compacting;
      compact(ctx, note);
      return { content: [{ type: "text", text: running ? "Compaction is already in progress." : "Compaction requested. Continue from the summary and handoff note." }], details: undefined };
    },
  });

  pi.on("turn_end", (_event, ctx) => {
    const usage = usageFor(ctx);
    if (!usage || compacting) return;
    if (configProblem(ctx, usage.effectiveWindow)) return;
    const state = thresholdState(usage.tokens!, usage.effectiveWindow, config);
    if (state !== "force") forceFailed = false;
    if (state === "force") {
      if (!forceFailed) {
        compact(ctx);
        lastTier = "below";
      }
      return;
    }
    if (state !== lastTier && (state === "notice" || state === "warning")) {
      lastTier = state;
      return {
        entries: [{
          type: "custom_message",
          customType: "self_compact_threshold",
          content: state === "notice"
            ? `Context notice threshold reached (${usage.tokens!.toLocaleString()} of ${usage.effectiveWindow.toLocaleString()} tokens). Continue working, and consider self_compact at a natural stopping point.`
            : `Context warning threshold reached (${usage.tokens!.toLocaleString()} of ${usage.effectiveWindow.toLocaleString()} tokens). Wrap up the current step and call self_compact with a handoff note soon.`,
          display: true,
        }],
        continue: true,
      };
    }
    if (state === "below") lastTier = "below";
  });

  pi.on("tool_call", (event, ctx) => {
    const usage = usageFor(ctx);
    if (!usage || event.toolName === "self_compact" || forceFailed || checkThresholds(config, usage.effectiveWindow)) return;
    if (thresholdState(usage.tokens!, usage.effectiveWindow, config) !== "force") return;
    compact(ctx);
    return { block: true, terminate: true, reason: "Forced self-compaction at the configured context threshold." };
  });

  const configureForModel = async (provider: string | undefined, modelId: string | undefined, ctx: ExtensionContext) => {
    const notify = (text: string, error: unknown, fallback: string) => {
      if (ctx.hasUI) ctx.ui.notify(`${text}: ${error instanceof Error ? error.message : String(error)}. ${fallback}`, "error");
    };
    const load = async (path: string) => {
      try {
        const file = await loadProfileFile(path);
        return provider && modelId ? profileForModel(file, provider, modelId) : file.default ?? {};
      } catch (error) {
        notify(`Could not load ${path}`, error, "Ignoring that file.");
        return {};
      }
    };
    const profile = { ...(await load(profilePath)), ...(await load(join(ctx.cwd, ".pi", "self-compact.json"))) };
    try {
      config = resolveConfig(flagOverrides(), profile);
    } catch (error) {
      // The files' values were checked as they loaded, so a --compact-* flag is at fault.
      config = resolveConfig({}, profile);
      notify("Invalid --compact-* flag", error, "Ignoring the flags.");
    }
  };

  pi.on("model_select", async (event, ctx) => {
    activeContextWindow = event.model.contextWindow;
    await configureForModel(event.model.provider, event.model.id, ctx);
    lastTier = "below";
    forceFailed = false;
    installFooter(ctx);
  });
  pi.on("session_start", async (_event, ctx) => {
    await configureForModel(ctx.model?.provider, ctx.model?.id, ctx);
    installFooter(ctx);
  });
  pi.on("session_compact", (_event, _ctx) => {
    lastTier = "below";
    compacting = false;
    forceFailed = false;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setFooter(undefined);
    ctx.ui.setWidget("self-compact", undefined);
  });

  pi.registerCommand("self-compact-info", {
    description: "Show self-compaction thresholds and current context usage",
    handler: async (_args, ctx) => {
      const usage = usageFor(ctx);
      const current = usage ? `${usage.tokens?.toLocaleString()} / ${usage.effectiveWindow.toLocaleString()} tokens` : "usage unknown";
      if (!usage) return ctx.ui.notify("Context usage unknown; thresholds depend on the context window.", "info");
      const limit = usage.effectiveWindow;
      ctx.ui.notify(`Context ${current}. Notice ${thresholdTokens(config.notice, limit).toLocaleString()}, warning ${thresholdTokens(config.warning, limit).toLocaleString()}, force ${thresholdTokens(config.force, limit).toLocaleString()} tokens.`, "info");
    },
  });

  pi.registerCommand("self-compact-now", {
    description: "Compact now, optionally preserving a handoff note",
    handler: async (args, ctx) => compact(ctx, args.trim() || undefined),
  });
}
