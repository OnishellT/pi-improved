// Links the owner's pi credentials into the reviewer's profile. Symlinks, never copies:
// a copied OAuth file goes stale when the main profile refreshes and rotates its token.
import { existsSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

function linkOf(path: string) {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

const canonical = (dir: string) => (existsSync(dir) ? realpathSync(dir) : resolve(dir));

// The reviewer profile is rewritten on every run: if it were the main profile (or inside or
// around it), its settings would be overwritten and auth.json replaced by a link to itself.
export function checkSeparateProfiles(mainDir: string, piDir: string) {
  const [main, pi] = [canonical(mainDir), canonical(piDir)];
  const inside = (a: string, b: string) => a === b || a.startsWith(`${b}/`);
  if (inside(main, pi) || inside(pi, main)) {
    throw new Error(`the reviewer profile ${pi} overlaps the main pi profile ${main}: set REVIEW_PI_DIR elsewhere`);
  }
}

// auth.json is required; models-store.json is a cache pi may not have written yet.
export function linkCredentials(mainDir: string, piDir: string, provider: string) {
  for (const [file, required] of [
    ["auth.json", true],
    ["models-store.json", false],
  ] as const) {
    const source = resolve(mainDir, file);
    const target = join(piDir, file);
    if (!existsSync(source)) {
      if (required) throw new Error(`${source} is missing: sign pi in to the ${provider} provider first`);
      rmSync(target, { force: true });
      continue;
    }
    if (linkOf(target) === source) continue;
    // Anything else (a link to another main profile, a dangling link, a copy) is replaced
    // atomically, so a concurrent review never sees the file missing.
    const temporary = `${target}.${process.pid}`;
    rmSync(temporary, { force: true });
    symlinkSync(source, temporary);
    renameSync(temporary, target);
  }
}
