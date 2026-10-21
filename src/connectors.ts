import type { McpConfig } from "./manifest.ts";

export interface Connector {
  id: string;
  name: string;
  purpose: string;
  /** Remote MCP server with OAuth sign-in; absent when the user must configure it in mcp.json. */
  mcp?: McpConfig;
}

/** Vetted connectors. Only these can be enabled from /setup. */
export const CATALOG: Connector[] = [
  { id: "github", name: "GitHub", purpose: "issues, pull requests and reviews", mcp: { url: "https://api.githubcopilot.com/mcp/" } },
  { id: "jira", name: "Jira", purpose: "tickets, epics and acceptance criteria", mcp: { url: "https://mcp.atlassian.com/v1/mcp" } },
  { id: "linear", name: "Linear", purpose: "issues and project plans", mcp: { url: "https://mcp.linear.app/mcp" } },
  { id: "slack", name: "Slack", purpose: "team discussions and decisions" },
];

export const connectorById = (id: string) => CATALOG.find((c) => c.id === id);

export interface ConnectorSignal {
  id: string;
  evidence: string;
}

/** Infers likely connectors from git remotes, commit subjects and doc text. */
export function detectConnectors(input: { remotes: string; commits: string; docs: string }): ConnectorSignal[] {
  const found = new Map<string, string>();
  const note = (id: string, evidence: string) => found.has(id) || found.set(id, evidence);

  if (/github\.com[:/]/.test(input.remotes)) note("github", "git remote points to github.com");
  const ticket = input.commits.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/);
  if (/atlassian\.net|jira/i.test(input.docs)) note("jira", "docs mention Jira/atlassian.net");
  if (/linear\.app/i.test(input.docs)) note("linear", "docs mention linear.app");
  // TEAM-123 keys are used by both Jira and Linear; offer Jira unless Linear is already evident.
  if (ticket && !found.has("linear")) note("jira", `commit messages reference tickets like ${ticket[0]}`);
  if (/slack\.com|hooks\.slack/i.test(input.docs)) note("slack", "docs mention Slack");

  return [...found].map(([id, evidence]) => ({ id, evidence }));
}
