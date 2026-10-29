// Pure selection of review context from the changed paths and the repository's file listing.

// Repository documents the reviewer always gets (when the base branch has them), then docs/*.md.
const rootDocs = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", "README.md"];

export function contextDocs(docsListing: readonly string[]): string[] {
  return [
    ...rootDocs,
    ...docsListing
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => `docs/${name}`),
  ];
}

// Paths that make a review necessary: anything that is not Markdown.
export function reviewablePaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !path.endsWith(".md"));
}

// A Markdown-only PR is skipped, unless an earlier review left threads that still need a
// verdict: then the change since that review decides (unknown change counts as reviewable).
export function skipsMarkdownOnly(
  changed: readonly string[],
  hadReview: boolean,
  deltaPaths: readonly string[] | undefined,
): boolean {
  if (reviewablePaths(changed).length > 0) return false;
  if (!hadReview) return true;
  return deltaPaths !== undefined && reviewablePaths(deltaPaths).length === 0;
}

// Linked issue numbers from `Closes #N` / `Fixes #N` / `Resolves #N` in a PR body.
export function linkedIssues(body: string): number[] {
  const numbers = [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((match) =>
    Number(match[1]),
  );
  return [...new Set(numbers)];
}
