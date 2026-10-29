// Links the owner's pi credentials into the reviewer's profile. Symlinks, never copies:
// a copied OAuth file goes stale when the main profile refreshes and rotates its token.
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// auth.json is required; models-store.json is a cache pi may not have written yet.
export function linkCredentials(mainDir: string, piDir: string, provider: string) {
  for (const [file, required] of [
    ["auth.json", true],
    ["models-store.json", false],
  ] as const) {
    const source = join(mainDir, file);
    const target = join(piDir, file);
    if (existsSync(target)) continue;
    if (isSymlink(target)) unlinkSync(target); // dangling: the main profile changed or signed out
    if (existsSync(source)) symlinkSync(source, target);
    else if (required) throw new Error(`${source} is missing: sign pi in to the ${provider} provider first`);
  }
}
