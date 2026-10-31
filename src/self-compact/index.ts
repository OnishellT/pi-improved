import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkThresholds, profileForModel, resolveConfig, sanitizeStatus, thresholdState, thresholdTokens } from "./config.ts";
import { globalPath, readGlobal } from "../config.ts";
import { SELF_COMPACT_EVENT, SELF_COMPACT_RESUME_EVENT, type SelfCompactPayload, type SelfCompactResumePayload } from "../events.ts";
import { migrateLegacy } from "../legacy-config.ts";
import { readProjectManifest } from "../manifest.ts";
import { checkProfileFile } from "./profile.ts";

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
  // Scheduled compactions that failed in a row. At MAX_FAILURES pi stops scheduling them, until a compaction succeeds.
  let failures = 0;
  const MAX_FAILURES = 2;
  const compactionOff = () => failures >= MAX_FAILURES;
  let lastTier = "below";
  let compacting = false;
  let activeContextWindow: number | undefined;

  const usageFor = (ctx: ExtensionContext, selectedContextWindow?: number) => {
    const usage = ctx.getContextUsage();
    const contextWindow = selectedContextWindow ?? activeContextWindow ?? usage?.contextWindow;
    if (!usage || usage.tokens == null || !contextWindow) return undefined;
    return { ...usage, contextWindow, effectiveWindow: contextWindow - config.buffer };
  };

  // A project's config file could put terminal escapes in a rejected value, which the error repeats.
  const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

  /** Shows an error in the UI, or on stderr when there is none (`pi -p`). */
  const report = (ctx: ExtensionContext, text: string) => {
    const safe = clean(text);
    if (ctx.hasUI) ctx.ui.notify(safe, "error");
    else console.error(`[self-compact] ${safe}`);
  };

  /** Why thresholds cannot be enforced for this window, or undefined. Notifies once per distinct problem. */
  const configProblem = (ctx: ExtensionContext, effectiveWindow: number) => {
    const error = checkThresholds(config, effectiveWindow);
    if (error && error !== notifiedError) report(ctx, `Self-compact: ${error}. Enforcement is off.`);
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
          const contextWindow = usage?.effectiveWindow ?? (activeContextWindow ?? ctx.model?.contextWindow ?? 0) - config.buffer;
          const tokens = usage?.tokens ?? 0;
          const percent = usage?.tokens == null || contextWindow <= 0 ? 0 : (tokens / contextWindow) * 100;
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

  // pi tells session_compact_failed whether a compaction was cancelled (Escape) before it calls onError.
  let compactionAborted = false;
  pi.on("session_compact_failed", (event) => {
    if (compacting) compactionAborted = event.aborted;
  });

  /**
   * Compacts with the note. Resolves "done" once pi has compacted, "busy" when another compaction is running,
   * "aborted" when it was cancelled, or the error.
   */
  const compact = (ctx: ExtensionContext, note?: string) => new Promise<"done" | "busy" | "aborted" | { error: string }>((resolve) => {
    if (compacting) return resolve("busy");
    compacting = true;
    compactionAborted = false;
    ctx.compact({
      customInstructions: [config.prompt, note ? `Agent handoff note:\n${note}` : ""].filter(Boolean).join("\n\n"),
      onComplete: () => {
        compacting = false;
        resolve("done");
      },
      onError: (error) => {
        compacting = false;
        forceFailed = true;
        // After the session is replaced (`/new`, `/resume`) or `pi -p` ends, any use of ctx throws, and nobody is left to tell.
        try {
          report(ctx, `Self-compaction failed: ${error.message}`);
        } catch {}
        resolve(compactionAborted ? "aborted" : { error: error.message });
      },
    });
  });

  // pi's ctx.compact() aborts the current run first, so a compaction the agent asks for waits until its run is over:
  // self_compact and the force threshold only schedule it, and the tool calls after that end the run (`terminate`).
  // `done` is set when pi compacted on its own (its auto-compaction) in the meantime, without the note.
  // `resume` is set when the agent asked for it or a call of its was blocked: then pi sends it a message to go on, also
  // when the compaction fails.
  // `followUp` is added to the resume message (setup's nudge, when setup is not finished).
  let pending: { note?: string; done?: boolean; resume: boolean; followUp?: string } | undefined;
  // Other modules (setup's nudge) must not continue a run that ends for a compaction, nor call it stopped.
  const announce = (scheduled: boolean, resume: boolean) => pi.events?.emit(SELF_COMPACT_EVENT, { scheduled, resume } satisfies SelfCompactPayload);
  const schedule = (next: NonNullable<typeof pending>) => {
    pending = next;
    announce(true, next.resume);
  };
  pi.events?.on(SELF_COMPACT_RESUME_EVENT, (data) => {
    if (pending) schedule({ ...pending, resume: true, followUp: (data as SelfCompactResumePayload).message });
  });
  let justCompacted = false; // no tool call since the last compaction: another one now would only summarize the summary
  const scheduled = "Compaction is scheduled, so this call did not run. Pi compacts when this turn ends and then continues.";
  const forceSteer = "call self_compact now with a handoff note, as the only call in your reply; pi then compacts and continues.";
  const scheduleForce = (resume: boolean) => {
    schedule({ resume });
    lastTier = "below";
  };
  // pi knows the usage again at the first response after a compaction. If it is still at the force threshold, forcing would
  // only compact and resume in a loop, so it stops as after a failed compaction, until usage drops below the threshold.
  let measureAfterCompaction = false;
  const checkAfterCompaction = (ctx: ExtensionContext, tokens: number, effectiveWindow: number, state: string) => {
    if (!measureAfterCompaction) return;
    measureAfterCompaction = false;
    if (state !== "force") return;
    forceFailed = true;
    report(ctx, `Context is still at the force threshold after compaction (${tokens.toLocaleString()} of ${effectiveWindow.toLocaleString()} tokens), so it is not forced again until usage drops below it.`);
  };

  pi.registerTool({
    name: "self_compact",
    label: "Self-compact",
    description: "End your turn so pi compacts the conversation and then continues. Add an optional handoff note with the goal, decisions, current state, and next action to preserve across compaction.",
    promptSnippet: "self_compact: end the turn, compact the context, and continue from a handoff note",
    promptGuidelines: [
      "Use self_compact when context nears the warning threshold, between steps: once a step is finished and checked (tests pass, a commit is made), not in the middle of an edit or while you still need a tool's output. In the handoff note, give the next action and what must not be redone.",
      "Calling self_compact ends your turn: pi compacts, then sends you a message to continue. Make it the last and only call in its reply.",
    ],
    parameters: Type.Object({ note: Type.Optional(Type.String({ description: "Continuation state to preserve in the compaction summary" })) }),
    execute: async (_id, { note }) => {
      const text = (value: string) => [{ type: "text" as const, text: value }];
      if (compacting) return { content: text("Compaction is already in progress."), details: undefined };
      if (compactionOff()) return { content: text("Not compacting: the last attempts failed. Continue with the next action."), details: undefined };
      if (justCompacted) return { content: text("The context was just compacted. Continue with the next action."), details: undefined };
      schedule({ ...pending, note: note ?? pending?.note, done: undefined, resume: true });
      return { content: text("Compaction scheduled. Pi compacts when this turn ends and then continues."), details: undefined, terminate: true };
    },
  });

  // agent_settled, not agent_end: pi has cleared the run here, so ctx.compact()'s abort has nothing to stop and its wait
  // for idle returns at once. pi awaits this handler, so `pi -p` does not exit before the compaction and the resumed run.
  // On Escape, before or during the compaction, it is dropped, with no resume. A resume sent from here starts once the
  // handlers are done.
  pi.on("agent_settled", async (event, ctx) => {
    const request = pending;
    pending = undefined;
    if (!request) return;
    const outcome = event.aborted ? "aborted" : request.done ? "done" : await compact(ctx, request.note);
    let content: string | undefined;
    if (outcome === "done") {
      failures = 0;
      content = request.done && request.note
        ? `Pi compacted the context. Continue with the next action from your handoff note:\n${request.note}`
        : `Compaction done. Continue with the next action from the ${request.note ? "handoff note" : "summary"}.`;
    } else if (typeof outcome === "object") {
      // The context is as it was, so the agent goes on. Failing again would only loop, so then pi stops compacting.
      const error = clean(outcome.error).trim().replace(/\.+$/, "");
      content = ++failures < MAX_FAILURES
        ? `Compaction failed: ${error}. Continue with the next action; do not call self_compact again until the context grows.`
        : `Compaction failed again: ${error}. Pi stops compacting until a compaction succeeds. Continue with the next action.`;
    }
    let resumed = request.resume && content !== undefined;
    if (resumed) {
      try {
        pi.sendMessage({ customType: "self_compact_resume", content: [content, request.followUp].filter(Boolean).join("\n\n"), display: true }, { triggerTurn: true });
      } catch {
        resumed = false; // the session was replaced during the compaction, and its agent is gone
      }
    }
    announce(false, resumed);
  });

  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") justCompacted = false;
  });

  pi.on("turn_end", (event, ctx) => {
    if (pending?.done) {
      pending = undefined; // pi compacted during the run and the agent went on by itself
      announce(false, false);
    }
    // A continuation from here would override the `terminate` that ends the run before the scheduled compaction.
    if (pending) return;
    const usage = usageFor(ctx);
    if (!usage || compacting) return;
    if (configProblem(ctx, usage.effectiveWindow)) return;
    const state = thresholdState(usage.tokens!, usage.effectiveWindow, config);
    checkAfterCompaction(ctx, usage.tokens!, usage.effectiveWindow, state);
    if (state !== "force") forceFailed = false;
    if (state === "force") {
      if (forceFailed || compactionOff()) return;
      // No tool results: the agent gave its answer and the run ends here, so pi compacts after it, with no resume, like
      // pi's own threshold compaction. Otherwise the run goes on with the next response, which can call self_compact.
      const answered = event.toolResults.length === 0;
      scheduleForce(!answered);
      if (answered) return;
      return {
        entries: [{
          type: "custom_message",
          customType: "self_compact_threshold",
          content: `Context force threshold reached (${usage.tokens!.toLocaleString()} of ${usage.effectiveWindow.toLocaleString()} tokens): ${forceSteer}`,
          display: true,
        }],
      };
    }
    if (state !== lastTier && (state === "notice" || state === "warning")) {
      lastTier = state;
      return {
        entries: [{
          type: "custom_message",
          customType: "self_compact_threshold",
          content: state === "notice"
            ? `Context notice threshold reached (${usage.tokens!.toLocaleString()} of ${usage.effectiveWindow.toLocaleString()} tokens). Continue working, and call self_compact once the current step is finished.`
            : `Context warning threshold reached (${usage.tokens!.toLocaleString()} of ${usage.effectiveWindow.toLocaleString()} tokens). Wrap up the current step and call self_compact with a handoff note soon.`,
          display: true,
        }],
        continue: true,
      };
    }
    if (state === "below") lastTier = "below";
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "self_compact") return;
    justCompacted = false;
    if (pending && !pending.done) {
      if (!pending.resume) schedule({ ...pending, resume: true }); // the agent had more to do
      return { block: true, terminate: true, reason: scheduled };
    }
    const usage = usageFor(ctx);
    if (!usage || compacting || checkThresholds(config, usage.effectiveWindow)) return;
    const state = thresholdState(usage.tokens!, usage.effectiveWindow, config);
    checkAfterCompaction(ctx, usage.tokens!, usage.effectiveWindow, state);
    if (state !== "force" || forceFailed || compactionOff()) return;
    // No `terminate` on the first blocked call: the model gets one turn to call self_compact with a note. Later calls end the run.
    scheduleForce(true);
    return { block: true, reason: `Context is at the force threshold, so this call did not run: ${forceSteer}` };
  });

  const configureForModel = async (provider: string | undefined, modelId: string | undefined, ctx: ExtensionContext) => {
    const notify = (text: string, error: unknown, fallback: string) =>
      report(ctx, `${text}: ${error instanceof Error ? error.message : String(error)}. ${fallback}`);
    const load = async (where: string, read: () => unknown) => {
      try {
        const file = checkProfileFile((await read()) ?? {});
        return provider && modelId ? profileForModel(file, provider, modelId) : file.default ?? {};
      } catch (error) {
        notify(`Could not load ${where}`, error, "Ignoring it.");
        return {};
      }
    };
    // Each file's own profile is resolved first, then the project's values win over the global ones.
    const profile = {
      ...(await load(`selfCompact in ${globalPath()}`, () => readGlobal().selfCompact)),
      ...(await load("selfCompact in .pi/workflow.json", async () => (await readProjectManifest(ctx.cwd)).selfCompact)),
    };
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
    failures = 0;
    installFooter(ctx);
  });
  pi.on("session_start", async (_event, ctx) => {
    // The old self-compact.json files are copied into the config files before the first read.
    const moved = migrateLegacy(ctx.cwd);
    if (moved.length) ctx.hasUI ? ctx.ui.notify(moved.join("\n"), "info") : console.error(`[self-compact] ${moved.join(" ")}`);
    await configureForModel(ctx.model?.provider, ctx.model?.id, ctx);
    installFooter(ctx);
  });
  pi.on("session_compact", (_event, _ctx) => {
    lastTier = "below";
    compacting = false;
    forceFailed = false;
    failures = 0;
    justCompacted = true;
    measureAfterCompaction = true;
    // Our own compaction runs after `pending` was taken, so this is pi's auto-compaction doing the scheduled one.
    if (pending) pending.done = true;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setFooter(undefined);
    ctx.ui.setWidget("self-compact", undefined);
  });

  pi.registerCommand("self-compact-info", {
    description: "Show self-compaction thresholds and current context usage",
    handler: async (_args, ctx) => {
      // Right after a compaction pi knows the window but not the tokens, which a bad buffer must not hide.
      const usage = usageFor(ctx);
      const window = activeContextWindow ?? ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
      if (!window) return ctx.ui.notify("Context window unknown; thresholds depend on it.", "info");
      const limit = window - config.buffer;
      const current = `${usage ? usage.tokens!.toLocaleString() : "?"} / ${limit.toLocaleString()} tokens`;
      const problem = checkThresholds(config, limit);
      ctx.ui.notify(`Context ${current}. Notice ${thresholdTokens(config.notice, limit).toLocaleString()}, warning ${thresholdTokens(config.warning, limit).toLocaleString()}, force ${thresholdTokens(config.force, limit).toLocaleString()} tokens.${problem ? ` ${problem}: enforcement is off.` : ""}`, "info");
    },
  });

  pi.registerCommand("self-compact-now", {
    description: "Compact now, optionally preserving a handoff note",
    // The user's own command: no resume afterwards, as with `/compact`.
    handler: async (args, ctx) => void compact(ctx, args.trim() || undefined),
  });
}
