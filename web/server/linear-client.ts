const LINEAR_API_URL = "https://api.linear.app/graphql";

export interface LinearIssue {
  identifier: string;
  title: string;
  description: string;
  state: string;
  priority: string;
  labels: string[];
  assignee: string | null;
  url: string;
  createdAt: string;
  cycle: string | null;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearLabel {
  id: string;
  name: string;
  color: string;
}

export interface LinearCycle {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
}

export interface LinearState {
  id: string;
  name: string;
  color: string;
  type: string;
}

export interface SearchParams {
  query?: string;
  team?: string;
  assignedToMe?: boolean;
  assignee?: string;
  state?: string;
  labels?: string[];
  cycle?: string;
  createdAfter?: string;
  subscribedByMe?: boolean;
  includeCompleted?: boolean;
  limit?: number;
}

// Runtime override — set by routes.ts when the user saves a key via Settings
let _runtimeApiKey: string | undefined;

export function setLinearApiKey(key: string | undefined): void {
  _runtimeApiKey = key || undefined;
}

export function hasApiKey(): boolean {
  return !!(_runtimeApiKey || process.env.LINEAR_API_KEY);
}

function getApiKey(): string {
  const key = _runtimeApiKey || process.env.LINEAR_API_KEY;
  if (!key) throw new Error("Linear API key is not configured. Set it in Settings or via the LINEAR_API_KEY environment variable.");
  return key;
}

async function linearQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const apiKey = getApiKey();
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Linear API error: ${response.status} - ${errorText}`);
  }

  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  return json.data as T;
}

export async function searchIssues(params: SearchParams): Promise<LinearIssue[]> {
  const limit = Math.min(params.limit ?? 25, 50);
  const filter: Record<string, unknown> = {};

  // Always fetch teams data for team/label resolution
  let teamsData: Array<{
    id: string;
    key: string;
    name: string;
    labels: { nodes: Array<{ id: string; name: string }> };
  }> | null = null;

  if (params.team || params.labels?.length) {
    const response = await linearQuery<{
      teams: {
        nodes: Array<{
          id: string;
          key: string;
          name: string;
          labels: { nodes: Array<{ id: string; name: string }> };
        }>;
      };
    }>(`query { teams { nodes { id key name labels { nodes { id name } } } } }`);
    teamsData = response.teams.nodes;
  }

  // Team filter
  let resolvedTeamId: string | undefined;
  if (params.team && teamsData) {
    const team = teamsData.find(
      (t) =>
        t.key.toLowerCase() === params.team!.toLowerCase() ||
        t.name.toLowerCase() === params.team!.toLowerCase(),
    );
    if (team) {
      resolvedTeamId = team.id;
      filter.team = { id: { eq: team.id } };
    }
  }

  // Assignee filter
  if (params.assignedToMe) {
    filter.assignee = { isMe: { eq: true } };
  } else if (params.assignee) {
    filter.assignee = { name: { containsIgnoreCase: params.assignee } };
  }

  // State filter
  if (params.state) {
    filter.state = { name: { containsIgnoreCase: params.state } };
  }

  // Label filter
  if (params.labels?.length && teamsData) {
    const allLabels = teamsData.flatMap((t) => t.labels.nodes);
    const seen = new Set<string>();
    const unique = allLabels.filter((l) => {
      if (seen.has(l.id)) return false;
      seen.add(l.id);
      return true;
    });

    const labelIds: string[] = [];
    for (const name of params.labels) {
      const label = unique.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (label) labelIds.push(label.id);
    }
    if (labelIds.length) {
      filter.labels = { some: { id: { in: labelIds } } };
    }
  }

  // Cycle filter
  if (params.cycle) {
    filter.cycle = { name: { containsIgnoreCase: params.cycle } };
    // Also try matching by number if it looks like a number
    if (/^\d+$/.test(params.cycle)) {
      filter.cycle = { number: { eq: parseInt(params.cycle, 10) } };
    }
    // Special: "current" cycle
    if (params.cycle === "current") {
      filter.cycle = { isActive: { eq: true } };
    }
  }

  // Age filter (createdAfter as ISO date string)
  if (params.createdAfter) {
    filter.createdAt = { gte: new Date(params.createdAfter).toISOString() };
  }

  // Subscriber filter (issues I'm subscribed to / "reviews")
  if (params.subscribedByMe) {
    filter.subscriber = { isMe: { eq: true } };
  }

  // Exclude completed/canceled unless explicitly included
  if (!params.includeCompleted) {
    filter.completedAt = { null: true };
    filter.canceledAt = { null: true };
  }

  const issueFields = `
    identifier title description
    state { name }
    priorityLabel
    assignee { name }
    labels { nodes { name } }
    cycle { name number }
    createdAt url
  `;

  type IssueNode = {
    identifier: string;
    title: string;
    description: string;
    state: { name: string };
    priorityLabel: string;
    assignee: { name: string } | null;
    labels: { nodes: Array<{ name: string }> };
    cycle: { name: string | null; number: number } | null;
    createdAt: string;
    url: string;
  };

  let nodes: IssueNode[];

  if (params.query) {
    const data = await linearQuery<{ issueSearch: { nodes: IssueNode[] } }>(
      `query($query: String!, $limit: Int!, $filter: IssueFilter) {
        issueSearch(query: $query, first: $limit, filter: $filter) {
          nodes { ${issueFields} }
        }
      }`,
      { query: params.query, limit, filter: Object.keys(filter).length ? filter : undefined },
    );
    nodes = data.issueSearch.nodes;
  } else {
    const data = await linearQuery<{ issues: { nodes: IssueNode[] } }>(
      `query($limit: Int!, $filter: IssueFilter) {
        issues(first: $limit, filter: $filter, orderBy: updatedAt) {
          nodes { ${issueFields} }
        }
      }`,
      { limit, filter: Object.keys(filter).length ? filter : undefined },
    );
    nodes = data.issues.nodes;
  }

  return nodes.map((n) => ({
    identifier: n.identifier,
    title: n.title,
    description: n.description || "",
    state: n.state.name,
    priority: n.priorityLabel,
    labels: n.labels.nodes.map((l) => l.name),
    assignee: n.assignee?.name ?? null,
    url: n.url,
    createdAt: n.createdAt,
    cycle: n.cycle ? (n.cycle.name || `Cycle ${n.cycle.number}`) : null,
  }));
}

export async function getIssue(issueId: string): Promise<LinearIssue> {
  const data = await linearQuery<{
    issue: {
      identifier: string;
      title: string;
      description: string;
      state: { name: string };
      priorityLabel: string;
      assignee: { name: string } | null;
      labels: { nodes: Array<{ name: string }> };
      cycle: { name: string | null; number: number } | null;
      createdAt: string;
      url: string;
    };
  }>(
    `query($id: String!) {
      issue(id: $id) {
        identifier title description
        state { name }
        priorityLabel
        assignee { name }
        labels { nodes { name } }
        cycle { name number }
        createdAt url
      }
    }`,
    { id: issueId },
  );

  const n = data.issue;
  return {
    identifier: n.identifier,
    title: n.title,
    description: n.description || "",
    state: n.state.name,
    priority: n.priorityLabel,
    labels: n.labels.nodes.map((l) => l.name),
    assignee: n.assignee?.name ?? null,
    url: n.url,
    createdAt: n.createdAt,
    cycle: n.cycle ? (n.cycle.name || `Cycle ${n.cycle.number}`) : null,
  };
}

export async function listTeams(): Promise<LinearTeam[]> {
  const data = await linearQuery<{
    teams: { nodes: Array<{ id: string; key: string; name: string }> };
  }>(`query { teams { nodes { id key name } } }`);
  return data.teams.nodes;
}

export async function listLabels(teamId?: string): Promise<LinearLabel[]> {
  if (teamId) {
    const data = await linearQuery<{
      team: { labels: { nodes: LinearLabel[] } };
    }>(
      `query($id: String!) { team(id: $id) { labels { nodes { id name color } } } }`,
      { id: teamId },
    );
    return data.team.labels.nodes;
  }

  const data = await linearQuery<{
    issueLabels: { nodes: LinearLabel[] };
  }>(`query { issueLabels(first: 250) { nodes { id name color } } }`);
  return data.issueLabels.nodes;
}

export async function listCycles(teamKey: string): Promise<LinearCycle[]> {
  // Resolve team key to ID
  const teamsResp = await linearQuery<{
    teams: { nodes: Array<{ id: string; key: string }> };
  }>(`query { teams { nodes { id key } } }`);
  const team = teamsResp.teams.nodes.find(
    (t) => t.key.toLowerCase() === teamKey.toLowerCase(),
  );
  if (!team) return [];

  const data = await linearQuery<{
    team: { cycles: { nodes: LinearCycle[] } };
  }>(
    `query($id: String!) {
      team(id: $id) {
        cycles(first: 20, orderBy: createdAt) {
          nodes { id number name startsAt endsAt }
        }
      }
    }`,
    { id: team.id },
  );
  return data.team.cycles.nodes;
}

export async function listStates(teamKey: string): Promise<LinearState[]> {
  const teamsResp = await linearQuery<{
    teams: { nodes: Array<{ id: string; key: string }> };
  }>(`query { teams { nodes { id key } } }`);
  const team = teamsResp.teams.nodes.find(
    (t) => t.key.toLowerCase() === teamKey.toLowerCase(),
  );
  if (!team) return [];

  const data = await linearQuery<{
    team: { states: { nodes: LinearState[] } };
  }>(
    `query($id: String!) {
      team(id: $id) {
        states { nodes { id name color type } }
      }
    }`,
    { id: team.id },
  );
  return data.team.states.nodes;
}

export async function listMembers(teamKey: string): Promise<{ id: string; name: string }[]> {
  const teamsResp = await linearQuery<{
    teams: { nodes: Array<{ id: string; key: string }> };
  }>(`query { teams { nodes { id key } } }`);
  const team = teamsResp.teams.nodes.find(
    (t) => t.key.toLowerCase() === teamKey.toLowerCase(),
  );
  if (!team) return [];

  const data = await linearQuery<{
    team: { members: { nodes: Array<{ id: string; name: string }> } };
  }>(
    `query($id: String!) {
      team(id: $id) {
        members { nodes { id name } }
      }
    }`,
    { id: team.id },
  );
  return data.team.members.nodes;
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  user: { name: string } | null;
}

export async function listIssueComments(issueIdentifier: string): Promise<LinearComment[]> {
  const data = await linearQuery<{
    issue: {
      comments: {
        nodes: Array<{
          id: string;
          body: string;
          createdAt: string;
          user: { name: string } | null;
        }>;
      };
    };
  }>(
    `query($id: String!) {
      issue(id: $id) {
        comments(first: 50, orderBy: createdAt) {
          nodes { id body createdAt user { name } }
        }
      }
    }`,
    { id: issueIdentifier },
  );
  return data.issue.comments.nodes;
}
