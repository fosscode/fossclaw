import { useStore } from "../store.js";
import type { LinearIssue, Playbook } from "../types.js";
import { findSuggestedPlaybooks } from "../utils/playbook.js";

interface Props {
  issue: LinearIssue;
  onSelect: (playbook: Playbook | null) => void;
  onCancel: () => void;
  onManage: () => void;
}

export function PlaybookSelector({ issue, onSelect, onCancel, onManage }: Props) {
  const playbooks = useStore((s) => s.playbooks);
  const suggested = findSuggestedPlaybooks(issue, playbooks);
  const others = playbooks.filter((pb) => !suggested.includes(pb));

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-cc-card rounded-[14px] shadow-lg w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-cc-border">
          <h3 className="text-sm font-semibold text-cc-fg">Select Playbook</h3>
          <p className="text-xs text-cc-muted mt-1 truncate">
            {issue.identifier}: {issue.title}
          </p>
        </div>

        {/* Content */}
        <div className="max-h-[400px] overflow-y-auto p-2">
          {/* No playbook option */}
          <button
            onClick={() => onSelect(null)}
            className="w-full px-3 py-2.5 text-left text-xs rounded-lg hover:bg-cc-hover transition-colors text-cc-fg cursor-pointer"
          >
            No playbook (just issue context)
          </button>

          {/* Suggested */}
          {suggested.length > 0 && (
            <>
              <div className="px-3 py-2 text-[10px] font-semibold text-cc-muted uppercase tracking-wide">
                Suggested
              </div>
              {suggested.map((pb) => (
                <button
                  key={pb.id}
                  onClick={() => onSelect(pb)}
                  className="w-full px-3 py-2.5 text-left rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
                >
                  <div className="text-xs font-medium text-cc-fg">{pb.name}</div>
                  {pb.description && (
                    <div className="text-[11px] text-cc-muted mt-0.5">{pb.description}</div>
                  )}
                  <div className="flex gap-1 mt-1">
                    {pb.autoMapLabels.map((label) => (
                      <span key={label} className="text-[9px] px-1.5 py-0.5 rounded-full bg-cc-primary/10 text-cc-primary">
                        {label}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
            </>
          )}

          {/* All playbooks */}
          {others.length > 0 && (
            <>
              <div className="px-3 py-2 text-[10px] font-semibold text-cc-muted uppercase tracking-wide">
                All Playbooks
              </div>
              {others.map((pb) => (
                <button
                  key={pb.id}
                  onClick={() => onSelect(pb)}
                  className="w-full px-3 py-2.5 text-left rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
                >
                  <div className="text-xs font-medium text-cc-fg">{pb.name}</div>
                  {pb.description && (
                    <div className="text-[11px] text-cc-muted mt-0.5">{pb.description}</div>
                  )}
                </button>
              ))}
            </>
          )}

          {playbooks.length === 0 && (
            <div className="px-3 py-6 text-xs text-cc-muted text-center leading-relaxed">
              No playbooks configured yet.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-cc-border flex justify-between items-center">
          <button
            onClick={onCancel}
            className="text-xs text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onManage}
            className="text-xs text-cc-primary hover:underline cursor-pointer"
          >
            Manage Playbooks
          </button>
        </div>
      </div>
    </div>
  );
}
