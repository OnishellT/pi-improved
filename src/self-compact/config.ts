export type Threshold = { value: number; percent: boolean; label: string };
export interface Config {
  notice: Threshold;
  warning: Threshold;
  force: Threshold;
  buffer: number;
  prompt: string;
}

export type ProfileValues = Partial<Record<"notice" | "warning" | "force" | "buffer" | "prompt", string | number>>;
export interface ProfileFile {
  default?: ProfileValues;
  models?: Record<string, ProfileValues>;
}

/**
 * Remove carriage returns, newlines, and tabs from text, replacing them with spaces and trimming.
 * Used to clean status text for single-line footer display.
 */
export const DEFAULTS = {
  notice: "75%",
  warning: "85%",
  force: "90%",
  buffer: 0,
  prompt: "Preserve the user's goal, constraints, decisions, completed work, current state, and next action. Do not restart completed work.",
};

export function profileForModel(file: ProfileFile, provider: string, modelId: string): ProfileValues {
  return { ...file.default, ...file.models?.[`${provider}/${modelId}`] };
}

export function parseThreshold(input: string | number): Threshold {
  const text = String(input).trim();
  const match = /^(\d+(?:\.\d+)?)\s*(k|m)?\s*(%)?$/i.exec(text);
  if (!match) throw new Error(`Invalid threshold: ${text}`);
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Threshold must be positive");
  if (match[3]) {
    if (match[2] || n > 90) throw new Error("Percentage threshold must be at most 90%");
    return { value: n / 100, percent: true, label: `${n}%` };
  }
  // Shift the decimal point in the text: in floating point, 2.01 * 1_000_000 is 2009999.9999999998.
  const digits = !match[2] ? 0 : match[2].toLowerCase() === "k" ? 3 : 6;
  const [whole, fraction = ""] = match[1].split(".");
  const value = fraction.length <= digits ? Number(whole + fraction.padEnd(digits, "0")) : NaN;
  if (!Number.isSafeInteger(value)) throw new Error("Threshold is outside the safe token range");
  return { value, percent: false, label: value.toLocaleString() };
}

export function resolveConfig(overrides: Record<string, unknown> = {}, profile: ProfileValues = {}): Config {
  const get = (name: keyof typeof DEFAULTS) => {
    const value = overrides[name] ?? profile[name] ?? DEFAULTS[name];
    return typeof value === "string" || typeof value === "number" ? value : String(value);
  };
  const buffer = Number(get("buffer"));
  if (!Number.isSafeInteger(buffer) || buffer < 0) throw new Error("Buffer must be a non-negative integer");
  return {
    notice: parseThreshold(get("notice")),
    warning: parseThreshold(get("warning")),
    force: parseThreshold(get("force")),
    buffer,
    prompt: String(get("prompt")),
  };
}

export function thresholdTokens(threshold: Threshold, limit: number): number {
  return threshold.percent ? threshold.value * limit : threshold.value;
}

export function checkThresholds(config: Config, limit: number): string | undefined {
  const values = [config.notice, config.warning, config.force].map((item) => thresholdTokens(item, limit));
  if (!(values[0] < values[1] && values[1] < values[2])) {
    return "Thresholds must be ordered notice < warning < force for this context window";
  }
  if (thresholdTokens(config.force, limit) >= limit) {
    return "Forced compaction threshold must be less than the context window size";
  }
  return undefined;
}

export function thresholdState(usage: number, limit: number, config: Config): "below" | "notice" | "warning" | "force" {
  if (!Number.isFinite(usage) || usage < 0 || !Number.isFinite(limit) || limit <= 0) throw new Error("Usage and limit must be valid");
  const error = checkThresholds(config, limit);
  if (error) throw new Error(error);
  const values = [config.notice, config.warning, config.force].map((item) => thresholdTokens(item, limit));
  if (usage >= values[2]) return "force";
  if (usage >= values[1]) return "warning";
  if (usage >= values[0]) return "notice";
  return "below";
}

export function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").trim();
}
