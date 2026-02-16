import type { LinearIssue, Playbook } from "../types.js";

export function renderTemplate(template: string, issue: LinearIssue): string {
  return template
    .replace(/\{\{issue\.identifier\}\}/g, issue.identifier)
    .replace(/\{\{issue\.title\}\}/g, issue.title)
    .replace(/\{\{issue\.description\}\}/g, issue.description || "")
    .replace(/\{\{issue\.url\}\}/g, issue.url)
    .replace(/\{\{issue\.state\}\}/g, issue.state)
    .replace(/\{\{issue\.priority\}\}/g, issue.priority)
    .replace(/\{\{issue\.labels\}\}/g, issue.labels.join(", ") || "None")
    .replace(/\{\{issue\.assignee\}\}/g, issue.assignee || "Unassigned");
}

export function buildDefaultContext(issue: LinearIssue): string {
  return `Working on Linear issue ${issue.identifier}: ${issue.title}

Description:
${issue.description || "No description"}

State: ${issue.state} | Priority: ${issue.priority} | Assignee: ${issue.assignee || "Unassigned"}
Labels: ${issue.labels.join(", ") || "None"}

Linear URL: ${issue.url}`;
}

export function findSuggestedPlaybooks(
  issue: LinearIssue,
  playbooks: Playbook[],
): Playbook[] {
  return playbooks.filter((pb) =>
    pb.autoMapLabels.some((label) =>
      issue.labels.some(
        (issueLabel) => issueLabel.toLowerCase() === label.toLowerCase(),
      ),
    ),
  );
}
