// Decides whether a follow-up round may review only the change since the last reviewed commit.
// `last..head` holds only the PR's own work when head still extends `last` on the same base;
// after a rebase onto a newer base or a force-push it also holds the base's changes, so the
// round falls back to a full review and says why.

export type GitRun = (args: string[]) => Promise<{ code: number; out: string }>;

export type DeltaPlan = { mode: "delta"; range: string } | { mode: "full"; reason?: string };

export async function planDelta(
  git: GitRun,
  lastReviewed: string | undefined,
  head: string,
  base: string,
): Promise<DeltaPlan> {
  if (lastReviewed === undefined || head.startsWith(lastReviewed)) return { mode: "full" };
  const short = lastReviewed.slice(0, 7);
  const full = (reason: string): DeltaPlan => ({
    mode: "full",
    reason: `Full review instead of a follow-up: ${reason}.`,
  });
  if ((await git(["cat-file", "-e", `${lastReviewed}^{commit}`])).code !== 0) {
    return full(`the last reviewed commit ${short} is no longer available`);
  }
  const mergeBase = async (commit: string) => {
    const result = await git(["merge-base", commit, base]);
    return result.code === 0 ? result.out.trim() : undefined;
  };
  const before = await mergeBase(lastReviewed);
  const now = await mergeBase(head);
  if (before === undefined || before !== now) {
    return full(`the branch moved onto a newer ${base} since the last reviewed commit ${short}`);
  }
  if ((await git(["merge-base", "--is-ancestor", lastReviewed, head])).code !== 0) {
    return full(`history was rewritten since the last reviewed commit ${short}`);
  }
  return { mode: "delta", range: `${lastReviewed}..${head}` };
}
