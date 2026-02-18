import type {
  CronJob,
  CheckerResult,
  CheckerTrigger,
  GitHubPRReviewConfig,
  GitHubCommentsCIConfig,
  E2ETestingConfig,
  LinearAgentConfig,
  DEFAULT_PROMPTS,
} from "./cron-types.js";
import { DEFAULT_PROMPTS as PROMPTS } from "./cron-types.js";
import * as linear from "./linear-client.js";

// ── GitHub API helpers ──────────────────────────────────────────────────

function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN environment variable is not set");
  return token;
}

async function githubFetch<T>(path: string): Promise<T> {
  const token = getGitHubToken();
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `token ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${text}`);
  }

  return response.json() as Promise<T>;
}

// ── Template helpers ────────────────────────────────────────────────────

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// ── PR Review Checker ──────────────────────────────────────────────────

interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  diff_url: string;
  updated_at: string;
  draft: boolean;
  user: { login: string };
  labels: Array<{ name: string }>;
  head: { ref: string; sha: string };
  base: { ref: string; repo: { full_name: string } };
}

export async function checkPRReview(job: CronJob): Promise<CheckerResult> {
  const config = job.config as GitHubPRReviewConfig;
  const triggers: CheckerTrigger[] = [];

  try {
    for (const repo of config.repos) {
      const prs = await githubFetch<GitHubPR[]>(
        `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=20`,
      );

      for (const pr of prs) {
        // Skip drafts if configured
        if (config.ignoreDrafts && pr.draft) continue;

        // Filter by labels
        const prLabels = pr.labels.map((l) => l.name.toLowerCase());
        if (config.filterLabels.length > 0) {
          const hasRequired = config.filterLabels.some((l) => prLabels.includes(l.toLowerCase()));
          if (!hasRequired) continue;
        }
        if (config.ignoreLabels.length > 0) {
          const hasIgnored = config.ignoreLabels.some((l) => prLabels.includes(l.toLowerCase()));
          if (hasIgnored) continue;
        }

        const template = config.promptTemplate || PROMPTS.pr_review;
        const prompt = renderTemplate(template, {
          "pr.title": pr.title,
          "pr.number": String(pr.number),
          "pr.repo": repo,
          "pr.url": pr.html_url,
          "pr.diff_url": pr.diff_url,
          "pr.body": pr.body || "(no description)",
          "pr.author": pr.user.login,
          "pr.branch": pr.head.ref,
          "pr.base": pr.base.ref,
        });

        triggers.push({
          dedupeKey: `pr:${repo}:${pr.number}:${pr.updated_at}`,
          sessionName: `PR Review: ${repo} #${pr.number}`,
          prompt,
          cwd: config.cwd,
          summary: `Review PR #${pr.number} in ${repo}: ${pr.title}`,
        });
      }
    }

    return { triggers };
  } catch (err) {
    return { triggers: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ── GitHub Comments/CI Checker ─────────────────────────────────────────

interface GitHubComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  user: { login: string };
  pull_request_url?: string;
}

interface GitHubIssueComment {
  id: number;
  body: string;
  created_at: string;
  html_url: string;
  user: { login: string };
}

interface GitHubCheckRun {
  id: number;
  name: string;
  conclusion: string | null;
  details_url: string | null;
  html_url: string;
}

export async function checkGitHubCommentsCi(job: CronJob): Promise<CheckerResult> {
  const config = job.config as GitHubCommentsCIConfig;
  const triggers: CheckerTrigger[] = [];

  try {
    for (const repo of config.repos) {
      // A) Check PR/issue comments for trigger keywords
      if (config.triggerKeywords.length > 0) {
        const since = job.lastRunAt ? new Date(job.lastRunAt).toISOString() : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const comments = await githubFetch<GitHubIssueComment[]>(
          `/repos/${repo}/issues/comments?since=${since}&per_page=50&sort=created&direction=desc`,
        );

        for (const comment of comments) {
          const bodyLower = comment.body.toLowerCase();
          const hasKeyword = config.triggerKeywords.some((kw) => bodyLower.includes(kw.toLowerCase()));
          if (!hasKeyword) continue;

          // Extract PR number from the comment URL
          const prMatch = comment.html_url.match(/\/pull\/(\d+)/);
          if (!prMatch) continue;
          const prNumber = prMatch[1];

          const template = config.commentPromptTemplate || PROMPTS.github_comment;
          const prompt = renderTemplate(template, {
            "pr.title": `PR #${prNumber}`,
            "pr.number": prNumber,
            "pr.repo": repo,
            "pr.url": `https://github.com/${repo}/pull/${prNumber}`,
            "comment.body": comment.body,
            "comment.author": comment.user.login,
            "comment.url": comment.html_url,
          });

          triggers.push({
            dedupeKey: `comment:${repo}:${comment.id}`,
            sessionName: `PR Comment: ${repo} #${prNumber}`,
            prompt,
            cwd: config.cwd,
            summary: `Handle comment by ${comment.user.login} on PR #${prNumber}`,
          });
        }
      }

      // B) Check CI failures on open PRs
      if (config.watchCIFailures) {
        const prs = await githubFetch<GitHubPR[]>(
          `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=10`,
        );

        for (const pr of prs) {
          const checkRuns = await githubFetch<{ check_runs: GitHubCheckRun[] }>(
            `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=50`,
          );

          const failures = checkRuns.check_runs.filter((cr) => cr.conclusion === "failure");
          if (failures.length === 0) continue;

          for (const failure of failures) {
            const template = config.ciFailurePromptTemplate || PROMPTS.ci_failure;
            const prompt = renderTemplate(template, {
              "pr.title": pr.title,
              "pr.number": String(pr.number),
              "pr.repo": repo,
              "pr.url": pr.html_url,
              "check.name": failure.name,
              "check.details_url": failure.details_url || failure.html_url,
            });

            triggers.push({
              dedupeKey: `ci:${repo}:${pr.number}:${failure.id}`,
              sessionName: `CI Fix: ${repo} #${pr.number} - ${failure.name}`,
              prompt,
              cwd: config.cwd,
              summary: `Fix CI failure "${failure.name}" on PR #${pr.number}`,
            });
          }
        }
      }
    }

    return { triggers };
  } catch (err) {
    return { triggers: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ── E2E Testing Checker ────────────────────────────────────────────────

export async function checkE2ETesting(job: CronJob): Promise<CheckerResult> {
  const config = job.config as E2ETestingConfig;

  try {
    const proc = Bun.spawn(["sh", "-c", config.testCommand], {
      cwd: config.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    const output = (stdout + "\n" + stderr).trim();

    // If onlyOnFailure and tests passed, skip
    if (config.onlyOnFailure && exitCode === 0) {
      return { triggers: [] };
    }

    if (exitCode === 0 && config.onlyOnFailure) {
      return { triggers: [] };
    }

    const template = config.promptTemplate || PROMPTS.e2e_testing;
    const prompt = renderTemplate(template, {
      "test.command": config.testCommand,
      "test.exitCode": String(exitCode),
      "test.output": output.substring(0, 10000), // Cap output length
    });

    // E2E tests use a timestamp-based dedup key since we want to run on each interval
    return {
      triggers: [{
        dedupeKey: `e2e:${Date.now()}`,
        sessionName: `E2E Fix: ${exitCode !== 0 ? "Tests Failed" : "Test Run"}`,
        prompt,
        cwd: config.cwd,
        summary: exitCode !== 0 ? `E2E tests failed (exit ${exitCode})` : "E2E test run completed",
      }],
    };
  } catch (err) {
    return { triggers: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Linear Agent Checker ───────────────────────────────────────────────

export async function checkLinearAgent(job: CronJob): Promise<CheckerResult> {
  const config = job.config as LinearAgentConfig;
  const triggers: CheckerTrigger[] = [];

  try {
    // Search for issues with the agent label
    const issues = await linear.searchIssues({
      team: config.teamKey,
      labels: [config.agentLabel],
      includeCompleted: false,
      limit: 25,
    });

    for (const issue of issues) {
      const template = config.promptTemplate || PROMPTS.linear_agent;
      const prompt = renderTemplate(template, {
        "issue.identifier": issue.identifier,
        "issue.title": issue.title,
        "issue.description": issue.description,
        "issue.url": issue.url,
        "issue.priority": issue.priority,
        "issue.labels": issue.labels.join(", "),
        "issue.state": issue.state,
        "issue.assignee": issue.assignee || "Unassigned",
      });

      triggers.push({
        dedupeKey: `linear:${issue.identifier}`,
        sessionName: `Linear: ${issue.identifier} - ${issue.title}`,
        prompt,
        cwd: config.cwd,
        summary: `Work on ${issue.identifier}: ${issue.title}`,
      });
    }

    // Check comments for @Agent mentions
    if (config.watchComments && config.commentTrigger) {
      for (const issue of issues) {
        try {
          const comments = await linear.listIssueComments(issue.identifier);
          for (const comment of comments) {
            if (!comment.body.includes(config.commentTrigger)) continue;

            const template = PROMPTS.linear_comment;
            const prompt = renderTemplate(template, {
              "issue.identifier": issue.identifier,
              "issue.title": issue.title,
              "issue.url": issue.url,
              "comment.body": comment.body,
              "comment.author": comment.user?.name || "Unknown",
            });

            triggers.push({
              dedupeKey: `linear-comment:${issue.identifier}:${comment.id}`,
              sessionName: `Linear Comment: ${issue.identifier}`,
              prompt,
              cwd: config.cwd,
              summary: `Handle @Agent comment on ${issue.identifier}`,
            });
          }
        } catch {
          // Skip comment fetch errors for individual issues
        }
      }
    }

    return { triggers };
  } catch (err) {
    return { triggers: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Dispatcher ─────────────────────────────────────────────────────────

export async function runChecker(job: CronJob): Promise<CheckerResult> {
  switch (job.type) {
    case "pr_review":
      return checkPRReview(job);
    case "github_comments_ci":
      return checkGitHubCommentsCi(job);
    case "e2e_testing":
      return checkE2ETesting(job);
    case "linear_agent":
      return checkLinearAgent(job);
    default:
      return { triggers: [], error: `Unknown job type: ${job.type}` };
  }
}
