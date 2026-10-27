import { readFile } from "node:fs/promises";
import { type ProfileFile, type ProfileValues, resolveConfig } from "./config.ts";

const fields = new Set(["notice", "warning", "force", "buffer", "prompt"]);

function profileValues(value: unknown, where: string): ProfileValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    if (!fields.has(key)) throw new Error(`Unknown setting ${where}.${key}`);
    if (typeof entry !== "string" && typeof entry !== "number") throw new Error(`${where}.${key} must be a string or number`);
    if (key === "prompt" && typeof entry !== "string") throw new Error(`${where}.prompt must be a string`);
  }
  // A bad threshold or buffer fails here, where the error can name its file.
  try {
    resolveConfig({}, value as ProfileValues);
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`);
  }
  return value as ProfileValues;
}

export function parseProfileFile(text: string): ProfileFile {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Self-compact config must be a JSON object");
  const document = value as Record<string, unknown>;
  for (const key of Object.keys(document)) {
    if (key !== "default" && key !== "models") throw new Error(`Unknown config section: ${key}`);
  }
  const profiles: ProfileFile = {};
  if (document.default !== undefined) profiles.default = profileValues(document.default, "default");
  if (document.models !== undefined) {
    if (!document.models || typeof document.models !== "object" || Array.isArray(document.models)) throw new Error("models must be an object keyed by provider/model");
    profiles.models = {};
    for (const [modelKey, settings] of Object.entries(document.models)) {
      if (!modelKey.includes("/") || modelKey.startsWith("/") || modelKey.endsWith("/")) throw new Error(`Model key must be provider/model: ${modelKey}`);
      profiles.models[modelKey] = profileValues(settings, `models.${modelKey}`);
    }
  }
  return profiles;
}

export async function loadProfileFile(path: string): Promise<ProfileFile> {
  try {
    return parseProfileFile(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
