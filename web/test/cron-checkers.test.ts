import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  checkPRReview,
  checkGitHubCommentsCi,
  checkE2ETesting,
  checkSlackChannel,
  checkLinearAgent,
  runChecker,
  setGitHubToken,
  setSlackBotToken,
} from "../server/cron-checkers.js";
import type { CronJob, GitHubPRReviewConfig, GitHubCommentsCIConfig, E2ETestingConfig, SlackChannelConfig, LinearAgentConfig } from "../server/cron-types.js";

// ─── Helpers ────────────────────────────────────────────────────────

function makeJob(type: CronJob["type"], config: any, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: randomUUID(),
    name: "Test Job",
    type,
    enabled: true,
    intervalSeconds: 300,
    config,
    lastRunAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ─── Template Rendering (tested indirectly through checkers) ────────

describe("Cron Checkers", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setGitHubToken("test-github-token");
    setSlackBotToken("test-slack-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ─── PR Review Checker ────────────────────────────────────────────

  describe("checkPRReview", () => {
    const baseConfig: GitHubPRReviewConfig = {
      repos: ["fosscode/fossclaw"],
      filterLabels: [],
      ignoreLabels: [],
      ignoreDrafts: false,
      cwd: "/tmp/project",
      promptTemplate: "",
    };

    test("generates triggers for open PRs", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify([
            {
              number: 42,
              title: "Add feature X",
              body: "Description of feature",
              html_url: "https://github.com/fosscode/fossclaw/pull/42",
              diff_url: "https://github.com/fosscode/fossclaw/pull/42.diff",
              updated_at: "2026-01-15T00:00:00Z",
              draft: false,
              user: { login: "testuser" },
              labels: [],
              head: { ref: "feature-x", sha: "abc123" },
              base: { ref: "main", repo: { full_name: "fosscode/fossclaw" } },
            },
          ]),
          { status: 200 }
        )
      );

      const job = makeJob("pr_review", baseConfig);
      const result = await checkPRReview(job);

      expect(result.triggers.length).toBe(1);
      expect(result.triggers[0].dedupeKey).toBe("pr:fosscode/fossclaw:42:2026-01-15T00:00:00Z");
      expect(result.triggers[0].sessionName).toBe("PR Review: fosscode/fossclaw #42");
      expect(result.triggers[0].prompt).toContain("Add feature X");
      expect(result.triggers[0].cwd).toBe("/tmp/project");
    });

    test("filters PRs by required labels", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify([
            {
              number: 1,
              title: "Has Label",
              body: null,
              html_url: "https://github.com/repo/pull/1",
              diff_url: "https://github.com/repo/pull/1.diff",
              updated_at: "2026-01-01T00:00:00Z",
              draft: false,
              user: { login: "user" },
              labels: [{ name: "review-me" }],
              head: { ref: "branch", sha: "abc" },
              base: { ref: "main", repo: { full_name: "repo" } },
            },
            {
              number: 2,
              title: "No Label",
              body: null,
              html_url: "https://github.com/repo/pull/2",
              diff_url: "https://github.com/repo/pull/2.diff",
              updated_at: "2026-01-01T00:00:00Z",
              draft: false,
              user: { login: "user" },
              labels: [],
              head: { ref: "branch2", sha: "def" },
              base: { ref: "main", repo: { full_name: "repo" } },
            },
          ]),
          { status: 200 }
        )
      );

      const config: GitHubPRReviewConfig = {
        ...baseConfig,
        filterLabels: ["review-me"],
      };
      const result = await checkPRReview(makeJob("pr_review", config));

      expect(result.triggers.length).toBe(1);
      expect(result.triggers[0].summary).toContain("#1");
    });

    test("ignores PRs with excluded labels", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify([
            {
              number: 1,
              title: "WIP PR",
              body: null,
              html_url: "https://github.com/repo/pull/1",
              diff_url: "https://github.com/repo/pull/1.diff",
              updated_at: "2026-01-01T00:00:00Z",
              draft: false,
              user: { login: "user" },
              labels: [{ name: "wip" }],
              head: { ref: "branch", sha: "abc" },
              base: { ref: "main", repo: { full_name: "repo" } },
            },
          ]),
          { status: 200 }
        )
      );

      const config: GitHubPRReviewConfig = {
        ...baseConfig,
        ignoreLabels: ["wip"],
      };
      const result = await checkPRReview(makeJob("pr_review", config));
      expect(result.triggers.length).toBe(0);
    });

    test("ignores draft PRs when configured", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify([
            {
              number: 1,
              title: "Draft PR",
              body: null,
              html_url: "https://github.com/repo/pull/1",
              diff_url: "https://github.com/repo/pull/1.diff",
              updated_at: "2026-01-01T00:00:00Z",
              draft: true,
              user: { login: "user" },
              labels: [],
              head: { ref: "branch", sha: "abc" },
              base: { ref: "main", repo: { full_name: "repo" } },
            },
          ]),
          { status: 200 }
        )
      );

      const config: GitHubPRReviewConfig = {
        ...baseConfig,
        ignoreDrafts: true,
      };
      const result = await checkPRReview(makeJob("pr_review", config));
      expect(result.triggers.length).toBe(0);
    });

    test("includes draft PRs when not configured to ignore", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify([
            {
              number: 1,
              title: "Draft PR",
              body: null,
              html_url: "https://github.com/repo/pull/1",
              diff_url: "https://github.com/repo/pull/1.diff",
              updated_at: "2026-01-01T00:00:00Z",
              draft: true,
              user: { login: "user" },
              labels: [],
              head: { ref: "branch", sha: "abc" },
              base: { ref: "main", repo: { full_name: "repo" } },
            },
          ]),
          { status: 200 }
        )
      );

      const config: GitHubPRReviewConfig = {
        ...baseConfig,
        ignoreDrafts: false,
      };
      const result = await checkPRReview(makeJob("pr_review", config));
      expect(result.triggers.length).toBe(1);
    });

    test("handles API errors gracefully", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("Network error");
      });

      const result = await checkPRReview(makeJob("pr_review", baseConfig));
      expect(result.triggers.length).toBe(0);
      expect(result.error).toContain("Network error");
    });

    test("uses custom prompt template when provided", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify([
            {
              number: 1,
              title: "Test PR",
              body: "body text",
              html_url: "https://github.com/repo/pull/1",
              diff_url: "https://github.com/repo/pull/1.diff",
              updated_at: "2026-01-01T00:00:00Z",
              draft: false,
              user: { login: "alice" },
              labels: [],
              head: { ref: "feat", sha: "abc" },
              base: { ref: "main", repo: { full_name: "repo" } },
            },
          ]),
          { status: 200 }
        )
      );

      const config: GitHubPRReviewConfig = {
        ...baseConfig,
        promptTemplate: "Review {{pr.title}} by {{pr.author}} on {{pr.branch}}",
      };
      const result = await checkPRReview(makeJob("pr_review", config));
      expect(result.triggers[0].prompt).toBe("Review Test PR by alice on feat");
    });

    test("handles multiple repos", async () => {
      let callCount = 0;
      globalThis.fetch = mock(async () => {
        callCount++;
        return new Response(
          JSON.stringify([
            {
              number: callCount,
              title: `PR from repo ${callCount}`,
              body: null,
              html_url: `https://github.com/repo${callCount}/pull/${callCount}`,
              diff_url: `https://github.com/repo${callCount}/pull/${callCount}.diff`,
              updated_at: "2026-01-01T00:00:00Z",
              draft: false,
              user: { login: "user" },
              labels: [],
              head: { ref: "branch", sha: "abc" },
              base: { ref: "main", repo: { full_name: `org/repo${callCount}` } },
            },
          ]),
          { status: 200 }
        );
      });

      const config: GitHubPRReviewConfig = {
        ...baseConfig,
        repos: ["org/repo1", "org/repo2"],
      };
      const result = await checkPRReview(makeJob("pr_review", config));
      expect(result.triggers.length).toBe(2);
    });

    test("label matching is case-insensitive", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify([
            {
              number: 1,
              title: "PR",
              body: null,
              html_url: "https://github.com/repo/pull/1",
              diff_url: "https://github.com/repo/pull/1.diff",
              updated_at: "2026-01-01T00:00:00Z",
              draft: false,
              user: { login: "user" },
              labels: [{ name: "Review-Me" }],
              head: { ref: "branch", sha: "abc" },
              base: { ref: "main", repo: { full_name: "repo" } },
            },
          ]),
          { status: 200 }
        )
      );

      const config: GitHubPRReviewConfig = {
        ...baseConfig,
        filterLabels: ["review-me"],
      };
      const result = await checkPRReview(makeJob("pr_review", config));
      expect(result.triggers.length).toBe(1);
    });
  });

  // ─── GitHub Comments/CI Checker ───────────────────────────────────

  describe("checkGitHubCommentsCi", () => {
    const baseConfig: GitHubCommentsCIConfig = {
      repos: ["fosscode/fossclaw"],
      triggerKeywords: ["@claude"],
      watchCIFailures: false,
      cwd: "/tmp/project",
      commentPromptTemplate: "",
      ciFailurePromptTemplate: "",
    };

    test("finds comments with trigger keywords", async () => {
      globalThis.fetch = mock(async (url: string) => {
        if (url.includes("issues/comments")) {
          return new Response(
            JSON.stringify([
              {
                id: 100,
                body: "Hey @claude, please review this",
                created_at: "2026-01-15T00:00:00Z",
                html_url: "https://github.com/fosscode/fossclaw/pull/5#issuecomment-100",
                user: { login: "alice" },
              },
              {
                id: 101,
                body: "LGTM",
                created_at: "2026-01-15T00:00:00Z",
                html_url: "https://github.com/fosscode/fossclaw/pull/5#issuecomment-101",
                user: { login: "bob" },
              },
            ]),
            { status: 200 }
          );
        }
        return new Response("[]", { status: 200 });
      });

      const result = await checkGitHubCommentsCi(makeJob("github_comments_ci", baseConfig));

      expect(result.triggers.length).toBe(1);
      expect(result.triggers[0].dedupeKey).toBe("comment:fosscode/fossclaw:100");
      expect(result.triggers[0].summary).toContain("alice");
    });

    test("skips comments without trigger keywords", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify([
            {
              id: 100,
              body: "Just a regular comment",
              created_at: "2026-01-15T00:00:00Z",
              html_url: "https://github.com/repo/pull/1#issuecomment-100",
              user: { login: "user" },
            },
          ]),
          { status: 200 }
        )
      );

      const result = await checkGitHubCommentsCi(makeJob("github_comments_ci", baseConfig));
      expect(result.triggers.length).toBe(0);
    });

    test("skips comments that are not on pull requests", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify([
            {
              id: 100,
              body: "@claude help me",
              created_at: "2026-01-15T00:00:00Z",
              html_url: "https://github.com/repo/issues/1#issuecomment-100",
              user: { login: "user" },
            },
          ]),
          { status: 200 }
        )
      );

      const result = await checkGitHubCommentsCi(makeJob("github_comments_ci", baseConfig));
      // Should skip because the URL doesn't match /pull/ pattern
      expect(result.triggers.length).toBe(0);
    });

    test("detects CI failures on PRs", async () => {
      let callCount = 0;
      globalThis.fetch = mock(async (url: string) => {
        if (url.includes("issues/comments")) {
          return new Response("[]", { status: 200 });
        }
        if (url.includes("/pulls?")) {
          return new Response(
            JSON.stringify([
              {
                number: 10,
                title: "Feature PR",
                body: null,
                html_url: "https://github.com/repo/pull/10",
                diff_url: "https://github.com/repo/pull/10.diff",
                updated_at: "2026-01-01T00:00:00Z",
                draft: false,
                user: { login: "user" },
                labels: [],
                head: { ref: "feat", sha: "sha123" },
                base: { ref: "main", repo: { full_name: "repo" } },
              },
            ]),
            { status: 200 }
          );
        }
        if (url.includes("/check-runs")) {
          return new Response(
            JSON.stringify({
              check_runs: [
                {
                  id: 500,
                  name: "tests",
                  conclusion: "failure",
                  details_url: "https://ci.example.com/run/500",
                  html_url: "https://github.com/repo/runs/500",
                },
                {
                  id: 501,
                  name: "lint",
                  conclusion: "success",
                  details_url: null,
                  html_url: "https://github.com/repo/runs/501",
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response("[]", { status: 200 });
      });

      const config: GitHubCommentsCIConfig = {
        ...baseConfig,
        triggerKeywords: [],
        watchCIFailures: true,
      };
      const result = await checkGitHubCommentsCi(makeJob("github_comments_ci", config));

      expect(result.triggers.length).toBe(1);
      expect(result.triggers[0].dedupeKey).toBe("ci:fosscode/fossclaw:10:500");
      expect(result.triggers[0].summary).toContain("tests");
    });

    test("handles API errors gracefully", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("API down");
      });

      const result = await checkGitHubCommentsCi(makeJob("github_comments_ci", baseConfig));
      expect(result.triggers).toEqual([]);
      expect(result.error).toContain("API down");
    });
  });

  // ─── E2E Testing Checker ──────────────────────────────────────────

  describe("checkE2ETesting", () => {
    test("triggers when tests fail and onlyOnFailure is true", async () => {
      const config: E2ETestingConfig = {
        testCommand: "exit 1",
        cwd: "/tmp",
        onlyOnFailure: true,
        promptTemplate: "",
      };

      const result = await checkE2ETesting(makeJob("e2e_testing", config));
      expect(result.triggers.length).toBe(1);
      expect(result.triggers[0].sessionName).toContain("Tests Failed");
      expect(result.triggers[0].dedupeKey).toMatch(/^e2e:/);
    });

    test("skips when tests pass and onlyOnFailure is true", async () => {
      const config: E2ETestingConfig = {
        testCommand: "true",
        cwd: "/tmp",
        onlyOnFailure: true,
        promptTemplate: "",
      };

      const result = await checkE2ETesting(makeJob("e2e_testing", config));
      expect(result.triggers.length).toBe(0);
    });

    test("triggers when tests pass and onlyOnFailure is false", async () => {
      const config: E2ETestingConfig = {
        testCommand: "echo 'All tests passed'",
        cwd: "/tmp",
        onlyOnFailure: false,
        promptTemplate: "",
      };

      const result = await checkE2ETesting(makeJob("e2e_testing", config));
      expect(result.triggers.length).toBe(1);
      expect(result.triggers[0].sessionName).toContain("Test Run");
    });

    test("captures test output in prompt", async () => {
      const config: E2ETestingConfig = {
        testCommand: "echo 'Test output here'",
        cwd: "/tmp",
        onlyOnFailure: false,
        promptTemplate: "",
      };

      const result = await checkE2ETesting(makeJob("e2e_testing", config));
      expect(result.triggers[0].prompt).toContain("Test output here");
    });

    test("uses custom prompt template", async () => {
      const config: E2ETestingConfig = {
        testCommand: "echo 'output'",
        cwd: "/tmp",
        onlyOnFailure: false,
        promptTemplate: "Tests ran: {{test.command}} with exit {{test.exitCode}}",
      };

      const result = await checkE2ETesting(makeJob("e2e_testing", config));
      expect(result.triggers[0].prompt).toContain("Tests ran: echo 'output' with exit 0");
    });

    test("handles command errors gracefully", async () => {
      const config: E2ETestingConfig = {
        testCommand: "/nonexistent_command_12345",
        cwd: "/tmp",
        onlyOnFailure: false,
        promptTemplate: "",
      };

      const result = await checkE2ETesting(makeJob("e2e_testing", config));
      // Should either trigger (non-zero exit) or return error
      expect(result.triggers.length + (result.error ? 1 : 0)).toBeGreaterThan(0);
    });

    test("generates unique dedup keys per invocation (timestamp-based)", async () => {
      const config: E2ETestingConfig = {
        testCommand: "true",
        cwd: "/tmp",
        onlyOnFailure: false,
        promptTemplate: "",
      };

      const result1 = await checkE2ETesting(makeJob("e2e_testing", config));
      await new Promise((r) => setTimeout(r, 5));
      const result2 = await checkE2ETesting(makeJob("e2e_testing", config));

      expect(result1.triggers[0].dedupeKey).not.toBe(result2.triggers[0].dedupeKey);
    });
  });

  // ─── Slack Channel Checker ────────────────────────────────────────

  describe("checkSlackChannel", () => {
    const baseConfig: SlackChannelConfig = {
      channels: ["C01ABC123"],
      triggerKeywords: [],
      ignoreBots: false,
      cwd: "/tmp",
      promptTemplate: "",
    };

    test("triggers for new messages", async () => {
      globalThis.fetch = mock(async (url: string) => {
        if (url.includes("conversations.info")) {
          return new Response(
            JSON.stringify({ ok: true, channel: { id: "C01ABC123", name: "general" } }),
            { status: 200 }
          );
        }
        if (url.includes("conversations.history")) {
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                { type: "message", ts: "1705276800.000100", user: "U123", text: "Hello world" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const result = await checkSlackChannel(makeJob("slack_channel", baseConfig));
      expect(result.triggers.length).toBe(1);
      expect(result.triggers[0].dedupeKey).toBe("slack:C01ABC123:1705276800.000100");
      expect(result.triggers[0].sessionName).toBe("Slack: #general");
    });

    test("filters by trigger keywords", async () => {
      globalThis.fetch = mock(async (url: string) => {
        if (url.includes("conversations.info")) {
          return new Response(
            JSON.stringify({ ok: true, channel: { id: "C01ABC123", name: "general" } }),
            { status: 200 }
          );
        }
        if (url.includes("conversations.history")) {
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                { type: "message", ts: "1.0", user: "U1", text: "Hey @agent help me" },
                { type: "message", ts: "2.0", user: "U2", text: "Just chatting" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const config: SlackChannelConfig = {
        ...baseConfig,
        triggerKeywords: ["@agent"],
      };
      const result = await checkSlackChannel(makeJob("slack_channel", config));
      expect(result.triggers.length).toBe(1);
      expect(result.triggers[0].prompt).toContain("@agent help me");
    });

    test("ignores bot messages when configured", async () => {
      globalThis.fetch = mock(async (url: string) => {
        if (url.includes("conversations.info")) {
          return new Response(
            JSON.stringify({ ok: true, channel: { id: "C01ABC123", name: "general" } }),
            { status: 200 }
          );
        }
        if (url.includes("conversations.history")) {
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                { type: "message", ts: "1.0", bot_id: "B123", text: "Bot message" },
                { type: "message", ts: "2.0", user: "U1", text: "Human message" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const config: SlackChannelConfig = {
        ...baseConfig,
        ignoreBots: true,
      };
      const result = await checkSlackChannel(makeJob("slack_channel", config));
      expect(result.triggers.length).toBe(1);
      expect(result.triggers[0].prompt).toContain("Human message");
    });

    test("skips message subtypes (e.g., channel_join)", async () => {
      globalThis.fetch = mock(async (url: string) => {
        if (url.includes("conversations.info")) {
          return new Response(
            JSON.stringify({ ok: true, channel: { id: "C01ABC123", name: "general" } }),
            { status: 200 }
          );
        }
        if (url.includes("conversations.history")) {
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                { type: "message", subtype: "channel_join", ts: "1.0", user: "U1", text: "joined" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const result = await checkSlackChannel(makeJob("slack_channel", baseConfig));
      expect(result.triggers.length).toBe(0);
    });

    test("handles Slack API errors gracefully", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("Slack unreachable");
      });

      const result = await checkSlackChannel(makeJob("slack_channel", baseConfig));
      expect(result.triggers).toEqual([]);
      expect(result.error).toContain("Slack unreachable");
    });

    test("falls back to channel ID when info fetch fails", async () => {
      globalThis.fetch = mock(async (url: string) => {
        if (url.includes("conversations.info")) {
          return new Response(
            JSON.stringify({ ok: false, error: "channel_not_found" }),
            { status: 200 }
          );
        }
        if (url.includes("conversations.history")) {
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [
                { type: "message", ts: "1.0", user: "U1", text: "Hello" },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const result = await checkSlackChannel(makeJob("slack_channel", baseConfig));
      expect(result.triggers.length).toBe(1);
      // Session name should use channel ID as fallback
      expect(result.triggers[0].sessionName).toBe("Slack: #C01ABC123");
    });
  });

  // ─── runChecker dispatcher ────────────────────────────────────────

  describe("runChecker (dispatcher)", () => {
    test("dispatches to PR review checker", async () => {
      globalThis.fetch = mock(async () =>
        new Response("[]", { status: 200 })
      );
      const result = await runChecker(
        makeJob("pr_review", {
          repos: ["test/repo"],
          filterLabels: [],
          ignoreLabels: [],
          ignoreDrafts: false,
          cwd: "/tmp",
          promptTemplate: "",
        })
      );
      expect(result.triggers).toBeArray();
    });

    test("dispatches to e2e testing checker", async () => {
      const result = await runChecker(
        makeJob("e2e_testing", {
          testCommand: "true",
          cwd: "/tmp",
          onlyOnFailure: false,
          promptTemplate: "",
        })
      );
      expect(result.triggers).toBeArray();
    });

    test("returns error for unknown job type", async () => {
      const result = await runChecker(
        makeJob("unknown_type" as any, {})
      );
      expect(result.triggers).toEqual([]);
      expect(result.error).toContain("Unknown job type");
    });
  });

  // ─── Token management ─────────────────────────────────────────────

  describe("token management", () => {
    test("GitHub token error when not set", async () => {
      setGitHubToken(undefined as any);
      // Clear env too
      const prev = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;

      const result = await checkPRReview(
        makeJob("pr_review", {
          repos: ["test/repo"],
          filterLabels: [],
          ignoreLabels: [],
          ignoreDrafts: false,
          cwd: "/tmp",
          promptTemplate: "",
        })
      );

      expect(result.error).toContain("GitHub token");
      process.env.GITHUB_TOKEN = prev;
    });

    test("Slack token error when not set", async () => {
      setSlackBotToken(undefined as any);
      const prev = process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_BOT_TOKEN;

      const result = await checkSlackChannel(
        makeJob("slack_channel", {
          channels: ["C01ABC123"],
          triggerKeywords: [],
          ignoreBots: false,
          cwd: "/tmp",
          promptTemplate: "",
        })
      );

      expect(result.error).toContain("Slack Bot Token");
      process.env.SLACK_BOT_TOKEN = prev;
    });
  });
});
