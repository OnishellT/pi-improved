// GitHub and git plumbing of the reviewer that can be tested without the network.
import { collectPages, type Page } from "./pages.ts";

// The local remote of the PR's repository (`gh repo view` may resolve to an upstream while
// `origin` is a fork). `remotes` is `git remote -v` output.
export function remoteFor(repo: string, remotes: string): string {
  const wanted = repo.toLowerCase();
  for (const line of remotes.split("\n")) {
    const [name, url = ""] = line.split(/\s+/);
    const path = /[:/]([^:/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1]?.toLowerCase();
    if (name && path === wanted) return name;
  }
  throw new Error(`no git remote points at ${repo}: add one (git remote add upstream <url>)`);
}

// `gh api graphql` arguments. -F would type-convert strings (`123`, `true`, `@file`), so only
// numbers use it.
export function graphqlArgs(query: string, vars: Record<string, string | number>): string[] {
  return [
    "api",
    "graphql",
    ...Object.entries(vars).flatMap(([key, value]) => [typeof value === "number" ? "-F" : "-f", `${key}=${value}`]),
    "-f",
    `query=${query}`,
  ];
}

export type Graphql = (query: string, vars: Record<string, string | number>) => Promise<unknown>;

const threadsQuery = `
query($owner:String!,$name:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$name){
pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved path line
comments(first:50){pageInfo{hasNextPage endCursor}nodes{databaseId createdAt author{login} body}}}}}}}`;

const threadCommentsQuery = `
query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{
comments(first:50,after:$after){pageInfo{hasNextPage endCursor}nodes{databaseId createdAt author{login} body}}}}}`;

export interface ThreadComment {
  databaseId: number;
  createdAt: string;
  author: { login: string } | null;
  body: string;
}

export interface ThreadNode {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  comments: Page<ThreadComment>;
}

const withCursor = (vars: Record<string, string | number>, cursor: string | null) =>
  cursor === null ? vars : { ...vars, after: cursor };

export async function fetchThreads(graphql: Graphql, owner: string, name: string, pr: number): Promise<ThreadNode[]> {
  const nodes = await collectPages(
    async (cursor) =>
      (
        (await graphql(threadsQuery, withCursor({ owner, name, pr }, cursor))) as {
          data: { repository: { pullRequest: { reviewThreads: Page<ThreadNode> } } };
        }
      ).data.repository.pullRequest.reviewThreads,
  );
  // A thread with more than 50 comments loses the rest of them without this.
  for (const node of nodes) {
    if (!node.comments.pageInfo.hasNextPage) continue;
    node.comments.nodes = await collectPages(
      async (cursor) =>
        (
          (await graphql(threadCommentsQuery, withCursor({ id: node.id }, cursor))) as {
            data: { node: { comments: Page<ThreadComment> } };
          }
        ).data.node.comments,
      node.comments,
    );
  }
  return nodes;
}
