import { describe, test, expect } from "bun:test";
import { extractSessionName } from "../server/smart-namer.ts";

describe("extractSessionName", () => {
  test("extracts action verb + subject from clear requests", () => {
    expect(extractSessionName("Fix the login bug where users cant authenticate with OAuth"))
      .toBe("Fix Login Bug Users Cant");

    expect(extractSessionName("Add dark mode to my react app"))
      .toBe("Add Dark Mode React App");

    expect(extractSessionName("Refactor the database queries"))
      .toBe("Refactor Database Queries");
  });

  test("handles implement/create/deploy verbs", () => {
    expect(extractSessionName("implement pagination for the /api/users endpoint"))
      .toBe("Implement Pagination Users Endpoint");

    expect(extractSessionName("create a new component for the settings page"))
      .toBe("Create New Component Settings Page");

    expect(extractSessionName("deploy this to AWS and configure the CI/CD pipeline"))
      .toBe("Deploy Aws Pipeline");
  });

  test("preserves filenames with extensions", () => {
    const name = extractSessionName("refactor the database queries in user-service.ts");
    expect(name).toContain("user-service.ts");
  });

  test("preserves README.md and config filenames", () => {
    const name = extractSessionName("update README.md with installation instructions");
    expect(name).toContain("readme.md");

    const name2 = extractSessionName("check the server.config.js file");
    expect(name2.toLowerCase()).toContain("server.config.js");
  });

  test("returns Code Review for code-only messages", () => {
    expect(extractSessionName("```python\ndef hello():\n  print('world')\n```"))
      .toBe("Code Review");
  });

  test("returns New Chat for very short/empty messages", () => {
    expect(extractSessionName("hello")).toBe("New Chat");
    expect(extractSessionName("hi")).toBe("New Chat");
    expect(extractSessionName("")).toBe("New Chat");
  });

  test("strips markdown formatting", () => {
    const name = extractSessionName("# Fix the **login** bug in `auth.ts`");
    expect(name.toLowerCase()).toContain("fix");
    expect(name.toLowerCase()).toContain("login");
    expect(name.toLowerCase()).toContain("bug");
  });

  test("strips URLs", () => {
    const name = extractSessionName("fix the bug at https://example.com/issues/123 in the auth module");
    expect(name).not.toContain("https");
    expect(name).not.toContain("example.com");
  });

  test("handles debugging requests", () => {
    const name = extractSessionName("help me debug the websocket connection dropping issue");
    expect(name.toLowerCase()).toContain("debug");
    expect(name.toLowerCase()).toContain("websocket");
  });

  test("caps name length at 50 characters", () => {
    const longMsg = "implement a comprehensive user authentication system with OAuth2 support including Google Facebook and GitHub providers with refresh token rotation and session management";
    const name = extractSessionName(longMsg);
    expect(name.length).toBeLessThanOrEqual(50);
  });

  test("produces title-cased output", () => {
    const name = extractSessionName("add a search feature to the dashboard");
    // Each word should start with uppercase (except filenames)
    const words = name.split(" ");
    for (const word of words) {
      if (!word.includes(".") && !word.includes("/") && !word.includes("_")) {
        expect(word[0]).toBe(word[0].toUpperCase());
      }
    }
  });

  test("handles multi-sentence messages (uses first sentence)", () => {
    const name = extractSessionName("Fix the login bug. Then also update the tests. And deploy to staging.");
    expect(name.toLowerCase()).toContain("fix");
    expect(name.toLowerCase()).toContain("login");
    expect(name.toLowerCase()).toContain("bug");
  });

  test("filters stop words and filler", () => {
    const name = extractSessionName("can you please help me just basically fix the authentication");
    expect(name.toLowerCase()).not.toContain("please");
    expect(name.toLowerCase()).not.toContain("basically");
    expect(name.toLowerCase()).toContain("fix");
    expect(name.toLowerCase()).toContain("authentication");
  });

  test("handles questions about errors", () => {
    const name = extractSessionName("why is my server crashing when I send a POST request?");
    expect(name.length).toBeGreaterThan(5);
    expect(name.toLowerCase()).toContain("server");
  });
});
