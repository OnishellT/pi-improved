// tmux starts a child in the server's environment, not the caller's, so pi-subagent's child loses PI_CODING_AGENT_DIR
// (and falls back to ~/.pi/agent). Forward it on the `env` line. Upstream text not found: leave the file as it is.
const ORIGINAL = "\t\t\t`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,\n";
const PATCHED = `${ORIGINAL}\t\t\t...(process.env.PI_CODING_AGENT_DIR ? [\`PI_CODING_AGENT_DIR=\${process.env.PI_CODING_AGENT_DIR}\`] : []),\n`;

/** Returns the patched source, or undefined when the original line is missing appears more than once, or is already patched. */
export function patchSharedSource(source) {
  return !source.includes(PATCHED) && source.split(ORIGINAL).length === 2 ? source.replace(ORIGINAL, () => PATCHED) : undefined;
}
