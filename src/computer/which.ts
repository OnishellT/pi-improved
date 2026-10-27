import * as fs from "node:fs";
import * as path from "node:path";

/** Absolute path of an executable file on PATH. Looked up, never run: some tools start a session on first use. */
export function which(bin: string, pathEnv = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, bin);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return undefined;
}
