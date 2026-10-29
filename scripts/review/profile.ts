// Links the owner's pi credentials into the reviewer's profile. Symlinks, never copies:
// a copied OAuth file goes stale when the main profile refreshes and rotates its token.
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

// auth.json is required; models-store.json is a cache pi may not have written yet.
export function linkCredentials(mainDir: string, piDir: string, provider: string) {
  for (const [file, required] of [
    ["auth.json", true],
    ["models-store.json", false],
  ] as const) {
    const source = resolve(mainDir, file);
    const target = join(piDir, file);
    // Relinked every run: an old link (another main profile, or signed out) or a copy goes.
    rmSync(target, { force: true });
    if (existsSync(source)) symlinkSync(source, target);
    else if (required) throw new Error(`${source} is missing: sign pi in to the ${provider} provider first`);
  }
}
