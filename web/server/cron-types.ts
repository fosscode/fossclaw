// ─── Cron Job Types ───────────────────────────────────────────────────────────

export type CronJobType = "pr_review" | "github_comments_ci" | "e2e_testing" | "linear_agent";

// ── Type-specific configs ──────────────────────────────────────────────

export interface GitHubPRReviewConfig {
  /** GitHub owner/repo pairs to watch, e.g. ["fosscode/fossclaw"] */
  repos: string[];
  /** Only review PRs with these labels (empty = all PRs) */
  filterLabels: string[];
  /** Ignore PRs with these labels (e.g. "wip", "draft") */
  ignoreLabels: string[];
  /** Ignore draft PRs */
  ignoreDrafts: boolean;
  /** Working directory for spawned Claude sessions */
  cwd: string;
  /** Custom prompt template */
  promptTemplate: string;
}

export interface GitHubCommentsCIConfig {
  /** GitHub owner/repo pairs to watch */
  repos: string[];
  /** Trigger keywords in PR comments (e.g. ["@claude", "@agent"]) */
  triggerKeywords: string[];
  /** Watch for CI failures on PRs */
  watchCIFailures: boolean;
  /** Working directory for spawned Claude sessions */
  cwd: string;
  /** Custom prompt template for comment triggers */
  commentPromptTemplate: string;
  /** Custom prompt template for CI failure triggers */
  ciFailurePromptTemplate: string;
}

export interface E2ETestingConfig {
  /** Command to run e2e tests */
  testCommand: string;
  /** Working directory where tests run */
  cwd: string;
  /** Only spawn Claude if tests fail */
  onlyOnFailure: boolean;
  /** Custom prompt template */
  promptTemplate: string;
}

export interface LinearAgentConfig {
  /** Linear team key to watch (e.g. "ENG") */
  teamKey: string;
  /** Label that marks issues for the agent (e.g. "Agent") */
  agentLabel: string;
  /** Also watch for @Agent mentions in comments */
  watchComments: boolean;
  /** Trigger keyword in comments (e.g. "@Agent") */
  commentTrigger: string;
  /** Working directory for spawned Claude sessions */
  cwd: string;
  /** Custom prompt template */
  promptTemplate: string;
  /** Move issue to this state when starting work */
  inProgressState: string;
}

export type CronJobConfigMap = {
  pr_review: GitHubPRReviewConfig;
  github_comments_ci: GitHubCommentsCIConfig;
  e2e_testing: E2ETestingConfig;
  linear_agent: LinearAgentConfig;
};

// ── Core types ──────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  name: string;
  type: CronJobType;
  enabled: boolean;
  /** Interval in seconds (e.g. 300 = every 5 minutes) */
  intervalSeconds: number;
  /** Type-specific configuration */
  config: CronJobConfigMap[CronJobType];
  /** Claude model to use for spawned sessions */
  model?: string;
  /** Permission mode for spawned sessions */
  permissionMode?: string;
  /** Timestamp of last run */
  lastRunAt: number | null;
  /** Timestamp of creation */
  createdAt: number;
  /** Timestamp of last modification */
  updatedAt: number;
}

export type CronRunStatus = "running" | "completed" | "failed" | "skipped";

export interface CronRun {
  id: string;
  jobId: string;
  startedAt: number;
  finishedAt: number | null;
  status: CronRunStatus;
  /** Session ID spawned (if any) */
  sessionId: string | null;
  /** Human-readable description of what triggered this run */
  triggerSummary: string;
  /** Error message if status is "failed" */
  error: string | null;
  /** Number of triggers found */
  triggerCount: number;
}

// ── Checker result ────────────────────────────────────────────────────

export interface CheckerTrigger {
  /** Unique key to deduplicate (e.g. "pr:fosscode/fossclaw:42") */
  dedupeKey: string;
  /** Session name for the spawned session */
  sessionName: string;
  /** Initial prompt to send to Claude */
  prompt: string;
  /** Working directory override */
  cwd?: string;
  /** Summary for the run log */
  summary: string;
}

export interface CheckerResult {
  triggers: CheckerTrigger[];
  /** Optional error message if the check itself failed */
  error?: string;
}

// ── Default prompt templates ────────────────────────────────────────────

export const DEFAULT_PROMPTS = {
  pr_review: `Review the following pull request and provide feedback on code quality, potential bugs, and improvements.

PR: {{pr.title}} (#{{pr.number}})
Repository: {{pr.repo}}
URL: {{pr.url}}

Please fetch the PR diff and provide a thorough code review with specific, actionable feedback.`,

  github_comment: `A comment on a pull request has requested your help:

PR: {{pr.title}} (#{{pr.number}})
Repository: {{pr.repo}}
URL: {{pr.url}}

Comment by {{comment.author}}:
"{{comment.body}}"

Please address this request.`,

  ci_failure: `CI has failed on a pull request. Please investigate and fix the failure.

PR: {{pr.title}} (#{{pr.number}})
Repository: {{pr.repo}}
URL: {{pr.url}}

Failed check: {{check.name}}
Details: {{check.details_url}}

Please investigate the failure and implement a fix.`,

  e2e_testing: `The following tests have failed. Please investigate and fix the failures.

Command: {{test.command}}
Exit code: {{test.exitCode}}

Test output:
\`\`\`
{{test.output}}
\`\`\``,

  linear_agent: `Work on the following Linear issue:

{{issue.identifier}}: {{issue.title}}

Description:
{{issue.description}}

Linear URL: {{issue.url}}
Priority: {{issue.priority}}
Labels: {{issue.labels}}

Please implement the required changes.`,

  linear_comment: `A comment on a Linear issue is requesting your help:

Issue: {{issue.identifier}}: {{issue.title}}
URL: {{issue.url}}

Comment by {{comment.author}}:
"{{comment.body}}"

Please address this request in the context of the issue.`,
} as const;
