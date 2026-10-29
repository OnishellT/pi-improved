// Cursor pagination over GraphQL connections.

export interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

// Follows endCursor until the connection reports no next page. `first` is a page the caller
// already has. A next page without a new cursor throws: stopping would drop data silently,
// and a cursor seen before would loop forever.
export async function collectPages<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
  first?: Page<T>,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let page: Page<T> = first ?? (await fetchPage(null));
  for (;;) {
    all.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return all;
    const next = page.pageInfo.endCursor;
    if (next === null || seen.has(next)) throw new Error("pagination did not advance");
    seen.add(next);
    page = await fetchPage(next);
  }
}
