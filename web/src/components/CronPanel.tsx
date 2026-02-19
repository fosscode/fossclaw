import { useState, useEffect } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { CronJob, CronJobType, CronRun, GitHubPRReviewConfig, GitHubCommentsCIConfig, E2ETestingConfig, LinearAgentConfig, SlackChannelConfig } from "../types.js";
import { DEFAULT_PROMPTS } from "../../server/cron-types.js";

interface Props {
  onClose: () => void;
}

const JOB_TYPE_LABELS: Record<CronJobType, string> = {
  pr_review: "PR Review",
  github_comments_ci: "GitHub Comments / CI",
  e2e_testing: "E2E Testing",
  linear_agent: "Linear Agent",
  slack_channel: "Slack Channel",
};

const JOB_TYPE_COLORS: Record<CronJobType, string> = {
  pr_review: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  github_comments_ci: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  e2e_testing: "bg-green-500/15 text-green-700 dark:text-green-300",
  linear_agent: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  slack_channel: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
};

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function getDefaultConfig(type: CronJobType): CronJob["config"] {
  switch (type) {
    case "pr_review":
      return { repos: [], filterLabels: [], ignoreLabels: [], ignoreDrafts: true, cwd: "", promptTemplate: "" } as GitHubPRReviewConfig;
    case "github_comments_ci":
      return { repos: [], triggerKeywords: ["@agent", "@claude"], watchCIFailures: true, cwd: "", commentPromptTemplate: "", ciFailurePromptTemplate: "" } as GitHubCommentsCIConfig;
    case "e2e_testing":
      return { testCommand: "bun test", cwd: "", onlyOnFailure: true, promptTemplate: "" } as E2ETestingConfig;
    case "linear_agent":
      return { teamKey: "", agentLabel: "Agent", watchComments: true, commentTrigger: "@Agent", cwd: "", promptTemplate: "", inProgressState: "" } as LinearAgentConfig;
    case "slack_channel":
      return { channels: [], triggerKeywords: [], ignoreBots: true, cwd: "", promptTemplate: "" } as SlackChannelConfig;
  }
}

// ── Tag Input Helper ────────────────────────────────────────────────────

function TagInput({ tags, onChange, placeholder }: { tags: string[]; onChange: (tags: string[]) => void; placeholder?: string }) {
  const [input, setInput] = useState("");

  function addTag() {
    const val = input.trim();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInput("");
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
          className="flex-1 px-3 py-1.5 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50"
          placeholder={placeholder || "Type and press Enter"}
        />
      </div>
      {tags.length > 0 && (
        <div className="flex gap-1 mt-1.5 flex-wrap">
          {tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-cc-primary/10 text-cc-primary">
              {tag}
              <button onClick={() => onChange(tags.filter((t) => t !== tag))} className="hover:text-cc-error cursor-pointer">x</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Type-specific Config Forms ──────────────────────────────────────────

function PRReviewConfigForm({ config, onChange }: { config: GitHubPRReviewConfig; onChange: (c: GitHubPRReviewConfig) => void }) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Repositories</span>
        <p className="text-[10px] text-cc-muted mb-1">Format: owner/repo (e.g. fosscode/fossclaw)</p>
        <TagInput tags={config.repos} onChange={(repos) => onChange({ ...config, repos })} placeholder="owner/repo" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Filter Labels (only review PRs with these)</span>
        <TagInput tags={config.filterLabels} onChange={(filterLabels) => onChange({ ...config, filterLabels })} placeholder="review-needed" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Ignore Labels</span>
        <TagInput tags={config.ignoreLabels} onChange={(ignoreLabels) => onChange({ ...config, ignoreLabels })} placeholder="wip, draft" />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={config.ignoreDrafts} onChange={(e) => onChange({ ...config, ignoreDrafts: e.target.checked })} className="rounded" />
        <span className="text-xs text-cc-fg">Ignore draft PRs</span>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Working Directory</span>
        <input type="text" value={config.cwd} onChange={(e) => onChange({ ...config, cwd: e.target.value })} className="w-full px-3 py-1.5 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="/path/to/repo" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Prompt Template (leave blank for default)</span>
        <textarea value={config.promptTemplate} onChange={(e) => onChange({ ...config, promptTemplate: e.target.value })} className="w-full px-3 py-2 mt-1 text-xs rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg font-mono-code resize-none focus:outline-none focus:border-cc-primary/50" rows={4} placeholder={DEFAULT_PROMPTS.pr_review} />
      </label>
    </div>
  );
}

function GitHubCommentsCIConfigForm({ config, onChange }: { config: GitHubCommentsCIConfig; onChange: (c: GitHubCommentsCIConfig) => void }) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Repositories</span>
        <TagInput tags={config.repos} onChange={(repos) => onChange({ ...config, repos })} placeholder="owner/repo" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Trigger Keywords in Comments</span>
        <TagInput tags={config.triggerKeywords} onChange={(triggerKeywords) => onChange({ ...config, triggerKeywords })} placeholder="@agent, @claude" />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={config.watchCIFailures} onChange={(e) => onChange({ ...config, watchCIFailures: e.target.checked })} className="rounded" />
        <span className="text-xs text-cc-fg">Watch for CI failures</span>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Working Directory</span>
        <input type="text" value={config.cwd} onChange={(e) => onChange({ ...config, cwd: e.target.value })} className="w-full px-3 py-1.5 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="/path/to/repo" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Comment Prompt Template</span>
        <textarea value={config.commentPromptTemplate} onChange={(e) => onChange({ ...config, commentPromptTemplate: e.target.value })} className="w-full px-3 py-2 mt-1 text-xs rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg font-mono-code resize-none focus:outline-none focus:border-cc-primary/50" rows={3} placeholder={DEFAULT_PROMPTS.github_comment} />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">CI Failure Prompt Template</span>
        <textarea value={config.ciFailurePromptTemplate} onChange={(e) => onChange({ ...config, ciFailurePromptTemplate: e.target.value })} className="w-full px-3 py-2 mt-1 text-xs rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg font-mono-code resize-none focus:outline-none focus:border-cc-primary/50" rows={3} placeholder={DEFAULT_PROMPTS.ci_failure} />
      </label>
    </div>
  );
}

function E2ETestingConfigForm({ config, onChange }: { config: E2ETestingConfig; onChange: (c: E2ETestingConfig) => void }) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Test Command</span>
        <input type="text" value={config.testCommand} onChange={(e) => onChange({ ...config, testCommand: e.target.value })} className="w-full px-3 py-1.5 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg font-mono-code focus:outline-none focus:border-cc-primary/50" placeholder="bun test" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Working Directory</span>
        <input type="text" value={config.cwd} onChange={(e) => onChange({ ...config, cwd: e.target.value })} className="w-full px-3 py-1.5 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="/path/to/project" />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={config.onlyOnFailure} onChange={(e) => onChange({ ...config, onlyOnFailure: e.target.checked })} className="rounded" />
        <span className="text-xs text-cc-fg">Only spawn agent on test failure</span>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Prompt Template</span>
        <textarea value={config.promptTemplate} onChange={(e) => onChange({ ...config, promptTemplate: e.target.value })} className="w-full px-3 py-2 mt-1 text-xs rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg font-mono-code resize-none focus:outline-none focus:border-cc-primary/50" rows={4} placeholder={DEFAULT_PROMPTS.e2e_testing} />
      </label>
    </div>
  );
}

function LinearAgentConfigForm({ config, onChange }: { config: LinearAgentConfig; onChange: (c: LinearAgentConfig) => void }) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Linear Team Key</span>
        <input type="text" value={config.teamKey} onChange={(e) => onChange({ ...config, teamKey: e.target.value })} className="w-full px-3 py-1.5 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="ENG" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Agent Label</span>
        <p className="text-[10px] text-cc-muted mb-1">Issues with this label will be picked up</p>
        <input type="text" value={config.agentLabel} onChange={(e) => onChange({ ...config, agentLabel: e.target.value })} className="w-full px-3 py-1.5 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="Agent" />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={config.watchComments} onChange={(e) => onChange({ ...config, watchComments: e.target.checked })} className="rounded" />
        <span className="text-xs text-cc-fg">Watch for comments with trigger keyword</span>
      </label>
      {config.watchComments && (
        <label className="block">
          <span className="text-xs font-medium text-cc-fg">Comment Trigger Keyword</span>
          <input type="text" value={config.commentTrigger} onChange={(e) => onChange({ ...config, commentTrigger: e.target.value })} className="w-full px-3 py-1.5 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="@Agent" />
        </label>
      )}
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Working Directory</span>
        <input type="text" value={config.cwd} onChange={(e) => onChange({ ...config, cwd: e.target.value })} className="w-full px-3 py-1.5 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="/path/to/project" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">In-Progress State (optional)</span>
        <p className="text-[10px] text-cc-muted mb-1">Move issue to this state when agent starts work</p>
        <input type="text" value={config.inProgressState} onChange={(e) => onChange({ ...config, inProgressState: e.target.value })} className="w-full px-3 py-1.5 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="In Progress" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Prompt Template</span>
        <textarea value={config.promptTemplate} onChange={(e) => onChange({ ...config, promptTemplate: e.target.value })} className="w-full px-3 py-2 mt-1 text-xs rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg font-mono-code resize-none focus:outline-none focus:border-cc-primary/50" rows={4} placeholder={DEFAULT_PROMPTS.linear_agent} />
      </label>
    </div>
  );
}

function SlackChannelConfigForm({ config, onChange }: { config: SlackChannelConfig; onChange: (c: SlackChannelConfig) => void }) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Channel IDs</span>
        <p className="text-[10px] text-cc-muted mb-1">Comma-separated Slack channel IDs (e.g. C01ABCDEF)</p>
        <input type="text" value={config.channels.join(", ")} onChange={(e) => onChange({ ...config, channels: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} className="w-full px-3 py-1.5 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="C01ABCDEF, C02GHIJKL" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Trigger Keywords</span>
        <TagInput tags={config.triggerKeywords} onChange={(triggerKeywords) => onChange({ ...config, triggerKeywords })} placeholder="Add keyword (empty = all messages)" />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={config.ignoreBots} onChange={(e) => onChange({ ...config, ignoreBots: e.target.checked })} className="rounded" />
        <span className="text-xs text-cc-fg">Ignore bot messages</span>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Working Directory</span>
        <input type="text" value={config.cwd} onChange={(e) => onChange({ ...config, cwd: e.target.value })} className="w-full px-3 py-1.5 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="/path/to/project" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-cc-fg">Prompt Template</span>
        <textarea value={config.promptTemplate} onChange={(e) => onChange({ ...config, promptTemplate: e.target.value })} className="w-full px-3 py-2 mt-1 text-xs rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg font-mono-code resize-none focus:outline-none focus:border-cc-primary/50" rows={4} placeholder={DEFAULT_PROMPTS.slack_channel} />
      </label>
    </div>
  );
}

// ── Run History ─────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="ml-1.5 text-[10px] text-cc-primary hover:underline cursor-pointer flex-shrink-0"
    >
      {copied ? "copied!" : "copy"}
    </button>
  );
}

function RunHistoryItem({ run }: { run: CronRun }) {
  const [expanded, setExpanded] = useState(false);

  const statusColors: Record<string, string> = {
    completed: "text-green-600 dark:text-green-400",
    failed: "text-red-600 dark:text-red-400",
    running: "text-blue-600 dark:text-blue-400",
    skipped: "text-yellow-600 dark:text-yellow-400",
  };

  const hasDetails = !!(run.triggerSummary || run.error);

  return (
    <div className="px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border">
      <div className="flex items-center justify-between">
        <span className={`text-xs font-medium ${statusColors[run.status] || "text-cc-muted"}`}>
          {run.status}
        </span>
        <span className="text-[10px] text-cc-muted">{formatTimeAgo(run.startedAt)}</span>
      </div>
      {run.triggerCount > 0 && (
        <p className="text-[11px] text-cc-fg mt-0.5">{run.triggerCount} trigger(s)</p>
      )}
      {hasDetails && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] text-cc-primary hover:underline mt-0.5 cursor-pointer"
        >
          {expanded ? "hide details" : "show details"}
        </button>
      )}
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {run.triggerSummary && (
            <div>
              <div className="flex items-center mb-0.5">
                <span className="text-[10px] font-medium text-cc-muted uppercase tracking-wide">Trigger</span>
                <CopyButton text={run.triggerSummary} />
              </div>
              <pre className="text-[10px] text-cc-fg bg-cc-bg border border-cc-border rounded p-2 whitespace-pre-wrap break-words font-mono-code">{run.triggerSummary}</pre>
            </div>
          )}
          {run.error && (
            <div>
              <div className="flex items-center mb-0.5">
                <span className="text-[10px] font-medium text-red-500 uppercase tracking-wide">Error</span>
                <CopyButton text={run.error} />
              </div>
              <pre className="text-[10px] text-red-400 bg-cc-bg border border-red-500/30 rounded p-2 whitespace-pre-wrap break-words font-mono-code">{run.error}</pre>
            </div>
          )}
        </div>
      )}
      {run.sessionId && (
        <button
          onClick={() => {
            useStore.getState().setCurrentSession(run.sessionId);
            useStore.getState().setShowCronPanel(false);
          }}
          className="text-[10px] text-cc-primary hover:underline mt-0.5 cursor-pointer block"
        >
          View session
        </button>
      )}
    </div>
  );
}

function RunHistory({ jobId }: { jobId: string }) {
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getCronJobRuns(jobId, 20).then((r) => { setRuns(r.runs); setLoading(false); }).catch(() => setLoading(false));
  }, [jobId]);

  if (loading) return <p className="text-xs text-cc-muted py-2">Loading runs...</p>;
  if (runs.length === 0) return <p className="text-xs text-cc-muted py-2">No runs yet</p>;

  return (
    <div className="space-y-1.5">
      {runs.map((run) => (
        <RunHistoryItem key={run.id} run={run} />
      ))}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────

export function CronPanel({ onClose }: Props) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CronJob | null>(null);
  const [creating, setCreating] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [type, setType] = useState<CronJobType>("linear_agent");
  const [intervalSeconds, setIntervalSeconds] = useState(300);
  const [intervalUnit, setIntervalUnit] = useState<"seconds" | "minutes" | "hours">("minutes");
  const [intervalValue, setIntervalValue] = useState(5);
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState("auto-accept");
  const [config, setConfig] = useState<CronJob["config"]>(getDefaultConfig("linear_agent"));
  const [saving, setSaving] = useState(false);

  const [saveError, setSaveError] = useState<string | null>(null);

  // View mode for selected job
  const [viewTab, setViewTab] = useState<"config" | "history">("config");

  useEffect(() => {
    loadJobs();
  }, []);

  async function loadJobs() {
    setLoading(true);
    try {
      const result = await api.listCronJobs();
      setJobs(result.jobs);
    } catch {
      // ignore
    }
    setLoading(false);
  }

  function resetForm() {
    setName("");
    setType("linear_agent");
    setIntervalValue(5);
    setIntervalUnit("minutes");
    setModel("");
    setPermissionMode("auto-accept");
    setConfig(getDefaultConfig("linear_agent"));
  }

  function handleCreate() {
    setCreating(true);
    setSelected(null);
    setViewTab("config");
    setSaveError(null);
    resetForm();
  }

  function handleSelect(job: CronJob) {
    setSelected(job);
    setCreating(false);
    setViewTab("config");
    setSaveError(null);
    setName(job.name);
    setType(job.type);
    setModel(job.model || "");
    setPermissionMode(job.permissionMode || "auto-accept");
    setConfig(job.config);

    // Convert seconds to best unit
    if (job.intervalSeconds >= 3600 && job.intervalSeconds % 3600 === 0) {
      setIntervalValue(job.intervalSeconds / 3600);
      setIntervalUnit("hours");
    } else if (job.intervalSeconds >= 60 && job.intervalSeconds % 60 === 0) {
      setIntervalValue(job.intervalSeconds / 60);
      setIntervalUnit("minutes");
    } else {
      setIntervalValue(job.intervalSeconds);
      setIntervalUnit("seconds");
    }
  }

  function computeIntervalSeconds(): number {
    switch (intervalUnit) {
      case "hours": return intervalValue * 3600;
      case "minutes": return intervalValue * 60;
      default: return intervalValue;
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      setSaveError("Job name is required");
      return;
    }
    setSaving(true);
    setSaveError(null);

    try {
      if (selected) {
        const updated = await api.updateCronJob(selected.id, {
          name: name.trim(),
          type,
          intervalSeconds: computeIntervalSeconds(),
          config,
          model: model || undefined,
          permissionMode,
        });
        setSelected(updated);
      } else {
        const created = await api.createCronJob({
          name: name.trim(),
          type,
          intervalSeconds: computeIntervalSeconds(),
          config,
          model: model || undefined,
          permissionMode,
          enabled: false,
        });
        setSelected(created);
        setCreating(false);
      }
      await loadJobs();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save job");
    }
    setSaving(false);
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteCronJob(id);
      if (selected?.id === id) {
        setSelected(null);
        resetForm();
      }
      await loadJobs();
    } catch {
      // ignore
    }
  }

  async function handleToggle(job: CronJob) {
    try {
      const updated = await api.toggleCronJob(job.id);
      if (selected?.id === job.id) setSelected(updated);
      await loadJobs();
    } catch {
      // ignore
    }
  }

  async function handleTrigger(job: CronJob) {
    try {
      await api.triggerCronJob(job.id);
      // Refresh runs after a short delay
      setTimeout(() => setViewTab("history"), 500);
    } catch {
      // ignore
    }
  }

  async function handleReset(job: CronJob) {
    try {
      await api.resetCronJob(job.id);
    } catch {
      // ignore
    }
  }

  function handleTypeChange(newType: CronJobType) {
    setType(newType);
    setConfig(getDefaultConfig(newType));
  }

  const showEditor = selected || creating;

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-cc-bg rounded-[14px] shadow-lg w-full max-w-4xl max-h-[85vh] flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: job list */}
        <div className="w-60 shrink-0 bg-cc-sidebar border-r border-cc-border flex flex-col">
          <div className="p-3 border-b border-cc-border">
            <h2 className="text-sm font-semibold text-cc-fg">Cron Jobs</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {loading && <p className="px-3 py-6 text-xs text-cc-muted text-center">Loading...</p>}
            {!loading && jobs.length === 0 && (
              <p className="px-3 py-6 text-xs text-cc-muted text-center">No cron jobs configured</p>
            )}
            {jobs.map((job) => (
              <div
                key={job.id}
                className={`px-3 py-2 rounded-lg transition-colors mb-1 cursor-pointer ${
                  selected?.id === job.id ? "bg-cc-active" : "hover:bg-cc-hover"
                }`}
                onClick={() => handleSelect(job)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-cc-fg truncate flex-1">{job.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggle(job); }}
                    className={`ml-2 w-8 h-4 rounded-full transition-colors flex-shrink-0 relative cursor-pointer ${
                      job.enabled ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"
                    }`}
                  >
                    <div className={`w-3 h-3 rounded-full bg-white absolute top-0.5 transition-transform ${
                      job.enabled ? "translate-x-4" : "translate-x-0.5"
                    }`} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${JOB_TYPE_COLORS[job.type]}`}>
                    {JOB_TYPE_LABELS[job.type]}
                  </span>
                  <span className="text-[10px] text-cc-muted">{formatInterval(job.intervalSeconds)}</span>
                </div>
                {job.lastRunAt && (
                  <p className="text-[10px] text-cc-muted mt-0.5">Last: {formatTimeAgo(job.lastRunAt)}</p>
                )}
              </div>
            ))}
          </div>
          <div className="p-2 border-t border-cc-border">
            <button
              onClick={handleCreate}
              className="w-full py-2 px-3 text-xs font-medium rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
            >
              + New Cron Job
            </button>
          </div>
        </div>

        {/* Right: editor / detail */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="p-3 border-b border-cc-border flex justify-between items-center">
            <h3 className="text-sm font-semibold text-cc-fg">
              {creating ? "New Cron Job" : selected ? selected.name : "Select a cron job"}
            </h3>
            <div className="flex items-center gap-2">
              {selected && !creating && (
                <>
                  <button onClick={() => setViewTab("config")} className={`text-xs px-2 py-1 rounded cursor-pointer ${viewTab === "config" ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg"}`}>Config</button>
                  <button onClick={() => setViewTab("history")} className={`text-xs px-2 py-1 rounded cursor-pointer ${viewTab === "history" ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg"}`}>History</button>
                </>
              )}
              <button onClick={onClose} className="text-xs text-cc-muted hover:text-cc-fg transition-colors cursor-pointer ml-2">Close</button>
            </div>
          </div>

          {showEditor ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Config tab or creating */}
              {(viewTab === "config" || creating) && (
                <>
                  {/* Name */}
                  <label className="block">
                    <span className="text-xs font-medium text-cc-fg">Name</span>
                    <input type="text" value={name} onChange={(e) => { setName(e.target.value); if (saveError === "Job name is required") setSaveError(null); }} className="w-full px-3 py-2 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="My Cron Job" />
                  </label>

                  {/* Type */}
                  <label className="block">
                    <span className="text-xs font-medium text-cc-fg">Job Type</span>
                    <select
                      value={type}
                      onChange={(e) => handleTypeChange(e.target.value as CronJobType)}
                      disabled={!!selected}
                      className="w-full px-3 py-2 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50 disabled:opacity-60"
                    >
                      {Object.entries(JOB_TYPE_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </label>

                  {/* Interval */}
                  <div>
                    <span className="text-xs font-medium text-cc-fg">Check Interval</span>
                    <div className="flex gap-2 mt-1">
                      <input
                        type="number"
                        min={1}
                        value={intervalValue}
                        onChange={(e) => setIntervalValue(Math.max(1, Number(e.target.value)))}
                        className="w-20 px-3 py-2 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50"
                      />
                      <select
                        value={intervalUnit}
                        onChange={(e) => setIntervalUnit(e.target.value as "seconds" | "minutes" | "hours")}
                        className="px-3 py-2 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50"
                      >
                        <option value="seconds">seconds</option>
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                      </select>
                    </div>
                  </div>

                  {/* Model + Permission Mode */}
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-xs font-medium text-cc-fg">Model (optional)</span>
                      <input type="text" value={model} onChange={(e) => setModel(e.target.value)} className="w-full px-3 py-2 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50" placeholder="default" />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-cc-fg">Permission Mode</span>
                      <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)} className="w-full px-3 py-2 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50">
                        <option value="auto-accept">Auto Accept</option>
                        <option value="default">Default (Ask)</option>
                        <option value="plan">Plan Mode</option>
                      </select>
                    </label>
                  </div>

                  {/* Type-specific config */}
                  <div className="border-t border-cc-border pt-4">
                    <h4 className="text-xs font-semibold text-cc-fg mb-3">{JOB_TYPE_LABELS[type]} Configuration</h4>
                    {type === "pr_review" && <PRReviewConfigForm config={config as GitHubPRReviewConfig} onChange={setConfig as any} />}
                    {type === "github_comments_ci" && <GitHubCommentsCIConfigForm config={config as GitHubCommentsCIConfig} onChange={setConfig as any} />}
                    {type === "e2e_testing" && <E2ETestingConfigForm config={config as E2ETestingConfig} onChange={setConfig as any} />}
                    {type === "linear_agent" && <LinearAgentConfigForm config={config as LinearAgentConfig} onChange={setConfig as any} />}
                    {type === "slack_channel" && <SlackChannelConfigForm config={config as SlackChannelConfig} onChange={setConfig as any} />}
                  </div>

                  {/* Actions */}
                  {saveError && (
                    <p className="text-xs text-cc-error bg-cc-error/10 px-3 py-2 rounded-lg">{saveError}</p>
                  )}
                  <div className="flex gap-2 pt-2 border-t border-cc-border">
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="px-4 py-2 text-xs font-medium rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      {saving ? "Saving..." : selected ? "Save Changes" : "Create Job"}
                    </button>
                    {selected && (
                      <>
                        <button
                          onClick={() => handleTrigger(selected)}
                          className="px-4 py-2 text-xs font-medium rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                        >
                          Run Now
                        </button>
                        <button
                          onClick={() => handleReset(selected)}
                          className="px-4 py-2 text-xs font-medium rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                          title="Clear seen triggers so all items are re-checked"
                        >
                          Reset Triggers
                        </button>
                        <button
                          onClick={() => handleDelete(selected.id)}
                          className="px-4 py-2 text-xs font-medium rounded-lg text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer ml-auto"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}

              {/* History tab */}
              {viewTab === "history" && selected && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-xs font-semibold text-cc-fg">Run History</h4>
                    <button
                      onClick={() => handleTrigger(selected)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
                    >
                      Run Now
                    </button>
                  </div>
                  <RunHistory jobId={selected.id} />
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <p className="text-sm text-cc-muted">Select a cron job or create a new one</p>
                <p className="text-xs text-cc-muted mt-1">Cron jobs watch for external triggers and spawn Claude sessions</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
