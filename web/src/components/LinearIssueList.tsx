import { useState, useEffect, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { LinearIssue } from "../types.js";

const AGE_OPTIONS = [
  { label: "Any time", value: "" },
  { label: "Last 24h", value: "1" },
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
];

export function LinearIssueList() {
  const [searchQuery, setSearchQuery] = useState("");
  const [teamFilter, setTeamFilter] = useState("ENG");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [subscribedByMe, setSubscribedByMe] = useState(false);
  const [stateFilter, setStateFilter] = useState("");
  const [cycleFilter, setCycleFilter] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [ageFilter, setAgeFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Filter option data
  const [teams, setTeams] = useState<{ id: string; key: string; name: string }[]>([]);
  const [states, setStates] = useState<{ id: string; name: string; color: string; type: string }[]>([]);
  const [cycles, setCycles] = useState<{ id: string; number: number; name: string | null; startsAt: string; endsAt: string }[]>([]);
  const [labels, setLabels] = useState<{ id: string; name: string; color: string }[]>([]);
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);

  const issues = useStore((s) => s.linearIssues);
  const loading = useStore((s) => s.linearLoading);
  const error = useStore((s) => s.linearError);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const [filterPos, setFilterPos] = useState<{ top: number; left: number } | null>(null);

  // Load teams on mount
  useEffect(() => {
    api.listLinearTeams().then((r) => setTeams(r.teams)).catch(() => {});
  }, []);

  // Load team-specific filter options when team changes
  useEffect(() => {
    if (!teamFilter) {
      setStates([]);
      setCycles([]);
      setLabels([]);
      setMembers([]);
      return;
    }
    api.listLinearStates(teamFilter).then((r) => setStates(r.states)).catch(() => setStates([]));
    api.listLinearCycles(teamFilter).then((r) => setCycles(r.cycles)).catch(() => setCycles([]));
    api.listLinearLabels(teamFilter).then((r) => setLabels(r.labels)).catch(() => setLabels([]));
    api.listLinearMembers(teamFilter).then((r) => setMembers(r.members)).catch(() => setMembers([]));
  }, [teamFilter]);

  // Load issues with debounce
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => loadIssues(), 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchQuery, teamFilter, assignedToMe, subscribedByMe, stateFilter, cycleFilter, labelFilter, assigneeFilter, ageFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close filter menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) {
        setShowFilters(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  async function loadIssues() {
    const store = useStore.getState();
    store.setLinearLoading(true);
    store.setLinearError(null);

    let createdAfter: string | undefined;
    if (ageFilter) {
      const d = new Date();
      d.setDate(d.getDate() - parseInt(ageFilter, 10));
      createdAfter = d.toISOString();
    }

    try {
      const result = await api.listLinearIssues({
        q: searchQuery || undefined,
        team: teamFilter || undefined,
        assignedToMe: assignedToMe || undefined,
        assignee: (!assignedToMe && assigneeFilter) || undefined,
        state: stateFilter || undefined,
        labels: labelFilter ? [labelFilter] : undefined,
        cycle: cycleFilter || undefined,
        createdAfter,
        subscribedByMe: subscribedByMe || undefined,
        limit: 50,
      });
      useStore.getState().setLinearIssues(result.issues);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      useStore.getState().setLinearError(msg);
    } finally {
      useStore.getState().setLinearLoading(false);
    }
  }

  function handleSelect(issue: LinearIssue) {
    useStore.getState().setLinearSelectedIssue(issue);
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function clearAllFilters() {
    setStateFilter("");
    setCycleFilter("");
    setLabelFilter("");
    setAssigneeFilter("");
    setAgeFilter("");
    setAssignedToMe(false);
    setSubscribedByMe(false);
  }

  const activeFilterCount = [
    stateFilter,
    cycleFilter,
    labelFilter,
    assigneeFilter,
    ageFilter,
    assignedToMe ? "1" : "",
    subscribedByMe ? "1" : "",
  ].filter(Boolean).length;

  const priorityColors: Record<string, string> = {
    Urgent: "text-red-500",
    High: "text-orange-500",
    Medium: "text-yellow-500",
    Low: "text-blue-400",
  };

  // Status → icon SVG + color
  function statusIndicator(state: string) {
    const s = state.toLowerCase();
    // Backlog / Triage
    if (s.includes("backlog") || s.includes("triage"))
      return { color: "text-gray-400", icon: <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2.5" /> };
    // Todo / Unstarted
    if (s.includes("todo") || s.includes("unstarted"))
      return { color: "text-gray-400", icon: <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" /> };
    // In Progress / Started
    if (s.includes("progress") || s.includes("started") || s.includes("review"))
      return { color: "text-yellow-500", icon: <><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M6 1a5 5 0 010 10" fill="currentColor" /></> };
    // Done / Completed / Merged
    if (s.includes("done") || s.includes("complete") || s.includes("merged"))
      return { color: "text-indigo-500", icon: <><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M3.5 6l2 2 3-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></> };
    // Canceled / Cancelled
    if (s.includes("cancel"))
      return { color: "text-gray-400", icon: <><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M4 4l4 4M8 4l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></> };
    // Default
    return { color: "text-gray-400", icon: <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" /> };
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Search */}
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search issues..."
        className="w-full px-3 py-2 text-xs rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
      />

      {/* Team + Filter button row */}
      <div className="flex items-center gap-2">
        {teams.length > 0 && (
          <select
            value={teamFilter}
            onChange={(e) => {
              setTeamFilter(e.target.value);
              // Reset team-specific filters
              setStateFilter("");
              setCycleFilter("");
              setLabelFilter("");
              setAssigneeFilter("");
            }}
            className="flex-1 px-2 py-1.5 text-[11px] rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none"
          >
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.key}>{t.key}</option>
            ))}
          </select>
        )}

        {/* Filter button */}
        <div className="relative" ref={filterMenuRef}>
          <button
            ref={filterBtnRef}
            onClick={() => {
              if (!showFilters && filterBtnRef.current) {
                const rect = filterBtnRef.current.getBoundingClientRect();
                setFilterPos({ top: rect.bottom + 4, left: rect.left });
              }
              setShowFilters(!showFilters);
            }}
            className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded-lg border transition-colors cursor-pointer ${
              activeFilterCount > 0
                ? "bg-cc-primary/10 border-cc-primary/30 text-cc-primary"
                : "bg-cc-input-bg border-cc-border text-cc-muted hover:text-cc-fg"
            }`}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path d="M1 2.75A.75.75 0 011.75 2h12.5a.75.75 0 010 1.5H1.75A.75.75 0 011 2.75zm2 4A.75.75 0 013.75 6h8.5a.75.75 0 010 1.5h-8.5A.75.75 0 013 6.75zm2 4a.75.75 0 01.75-.75h4.5a.75.75 0 010 1.5h-4.5a.75.75 0 01-.75-.75z" />
            </svg>
            Filters
            {activeFilterCount > 0 && (
              <span className="w-4 h-4 rounded-full bg-cc-primary text-white text-[9px] flex items-center justify-center font-bold">
                {activeFilterCount}
              </span>
            )}
          </button>

          {/* Filter dropdown — fixed so it overflows sidebar */}
          {showFilters && filterPos && (
            <div
              className="fixed w-60 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-50 py-2 max-h-[80vh] overflow-y-auto"
              style={{ top: filterPos.top, left: filterPos.left }}
            >
              {/* Quick toggles */}
              <div className="px-3 py-1.5 space-y-1.5">
                <label className="flex items-center gap-2 text-[11px] text-cc-fg cursor-pointer">
                  <input
                    type="checkbox"
                    checked={assignedToMe}
                    onChange={(e) => { setAssignedToMe(e.target.checked); if (e.target.checked) setAssigneeFilter(""); }}
                    className="rounded"
                  />
                  Assigned to me
                </label>
                <label className="flex items-center gap-2 text-[11px] text-cc-fg cursor-pointer">
                  <input
                    type="checkbox"
                    checked={subscribedByMe}
                    onChange={(e) => setSubscribedByMe(e.target.checked)}
                    className="rounded"
                  />
                  Subscribed / Reviews
                </label>
              </div>

              <div className="border-t border-cc-border my-1.5" />

              {/* Status filter */}
              <div className="px-3 py-1">
                <label className="text-[10px] font-semibold text-cc-muted uppercase tracking-wide">Status</label>
                <select
                  value={stateFilter}
                  onChange={(e) => setStateFilter(e.target.value)}
                  className="w-full mt-1 px-2 py-1.5 text-[11px] rounded-md bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none"
                >
                  <option value="">All statuses</option>
                  {states.map((s) => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>

              {/* Cycle filter */}
              <div className="px-3 py-1">
                <label className="text-[10px] font-semibold text-cc-muted uppercase tracking-wide">Cycle</label>
                <select
                  value={cycleFilter}
                  onChange={(e) => setCycleFilter(e.target.value)}
                  className="w-full mt-1 px-2 py-1.5 text-[11px] rounded-md bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none"
                >
                  <option value="">All cycles</option>
                  <option value="current">Current cycle</option>
                  {cycles.map((c) => (
                    <option key={c.id} value={String(c.number)}>
                      {c.name || `Cycle ${c.number}`}
                    </option>
                  ))}
                </select>
              </div>

              {/* Assignee filter */}
              {!assignedToMe && (
                <div className="px-3 py-1">
                  <label className="text-[10px] font-semibold text-cc-muted uppercase tracking-wide">Assignee</label>
                  <select
                    value={assigneeFilter}
                    onChange={(e) => setAssigneeFilter(e.target.value)}
                    className="w-full mt-1 px-2 py-1.5 text-[11px] rounded-md bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none"
                  >
                    <option value="">Anyone</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.name}>{m.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Label filter */}
              <div className="px-3 py-1">
                <label className="text-[10px] font-semibold text-cc-muted uppercase tracking-wide">Label</label>
                <select
                  value={labelFilter}
                  onChange={(e) => setLabelFilter(e.target.value)}
                  className="w-full mt-1 px-2 py-1.5 text-[11px] rounded-md bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none"
                >
                  <option value="">All labels</option>
                  {labels.map((l) => (
                    <option key={l.id} value={l.name}>{l.name}</option>
                  ))}
                </select>
              </div>

              {/* Age filter */}
              <div className="px-3 py-1">
                <label className="text-[10px] font-semibold text-cc-muted uppercase tracking-wide">Created</label>
                <select
                  value={ageFilter}
                  onChange={(e) => setAgeFilter(e.target.value)}
                  className="w-full mt-1 px-2 py-1.5 text-[11px] rounded-md bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none"
                >
                  {AGE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div className="border-t border-cc-border my-1.5" />

              {/* Clear all */}
              <div className="px-3 py-1">
                <button
                  onClick={clearAllFilters}
                  className="text-[11px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                >
                  Clear all filters
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Active filter chips */}
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-1">
          {assignedToMe && (
            <FilterChip label="Mine" onRemove={() => setAssignedToMe(false)} />
          )}
          {subscribedByMe && (
            <FilterChip label="Reviews" onRemove={() => setSubscribedByMe(false)} />
          )}
          {stateFilter && (
            <FilterChip label={stateFilter} onRemove={() => setStateFilter("")} />
          )}
          {cycleFilter && (
            <FilterChip label={cycleFilter === "current" ? "Current cycle" : `Cycle ${cycleFilter}`} onRemove={() => setCycleFilter("")} />
          )}
          {assigneeFilter && (
            <FilterChip label={assigneeFilter} onRemove={() => setAssigneeFilter("")} />
          )}
          {labelFilter && (
            <FilterChip label={labelFilter} onRemove={() => setLabelFilter("")} />
          )}
          {ageFilter && (
            <FilterChip
              label={AGE_OPTIONS.find((o) => o.value === ageFilter)?.label || ageFilter}
              onRemove={() => setAgeFilter("")}
            />
          )}
        </div>
      )}

      {/* Issue list */}
      {loading ? (
        <div className="px-3 py-8 text-xs text-cc-muted text-center">Loading...</div>
      ) : error ? (
        <div className="px-2 py-3 text-xs text-cc-error">{error}</div>
      ) : issues.length === 0 ? (
        <div className="px-3 py-8 text-xs text-cc-muted text-center leading-relaxed">
          No issues found.
        </div>
      ) : (
        <div className="space-y-0.5">
          {issues.map((issue) => (
            <button
              key={issue.identifier}
              onClick={() => handleSelect(issue)}
              className="w-full px-3 py-2.5 text-left rounded-[10px] hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <div className="flex items-start gap-2">
                {/* Status icon */}
                {(() => {
                  const si = statusIndicator(issue.state);
                  return (
                    <svg viewBox="0 0 12 12" className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${si.color}`}>
                      {si.icon}
                    </svg>
                  );
                })()}
                <span className="text-[13px] font-medium text-cc-fg line-clamp-2 leading-snug">
                  {issue.title}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-1.5 ml-[22px] flex-wrap">
                <span className="text-[10px] font-mono-code text-cc-muted">{issue.identifier}</span>
                <span className={`text-[10px] ${statusIndicator(issue.state).color}`}>{issue.state}</span>
                <span className={`text-[10px] ${priorityColors[issue.priority] || "text-cc-muted"}`}>
                  {issue.priority}
                </span>
                {issue.assignee && (
                  <span className="text-[10px] text-cc-muted">{issue.assignee}</span>
                )}
                {issue.labels.slice(0, 2).map((label) => (
                  <span
                    key={label}
                    className="text-[9px] px-1.5 py-0.5 rounded-full bg-cc-border text-cc-muted"
                  >
                    {label}
                  </span>
                ))}
                {issue.labels.length > 2 && (
                  <span className="text-[9px] text-cc-muted">+{issue.labels.length - 2}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full bg-cc-primary/10 text-cc-primary">
      {label}
      <button onClick={onRemove} className="hover:text-cc-error cursor-pointer">
        x
      </button>
    </span>
  );
}
