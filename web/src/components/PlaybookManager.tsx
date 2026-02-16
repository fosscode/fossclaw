import { useState } from "react";
import { useStore } from "../store.js";
import type { Playbook } from "../types.js";

interface Props {
  onClose: () => void;
}

export function PlaybookManager({ onClose }: Props) {
  const playbooks = useStore((s) => s.playbooks);
  const [editing, setEditing] = useState<Playbook | null>(null);
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState("");
  const [autoMapLabels, setAutoMapLabels] = useState<string[]>([]);
  const [labelInput, setLabelInput] = useState("");

  function resetForm() {
    setName("");
    setDescription("");
    setTemplate("");
    setAutoMapLabels([]);
    setLabelInput("");
  }

  function handleEdit(pb: Playbook) {
    setEditing(pb);
    setCreating(false);
    setName(pb.name);
    setDescription(pb.description || "");
    setTemplate(pb.template);
    setAutoMapLabels([...pb.autoMapLabels]);
  }

  function handleCreate() {
    setCreating(true);
    setEditing(null);
    resetForm();
  }

  function handleSave() {
    if (!name.trim() || !template.trim()) return;

    if (editing) {
      useStore.getState().updatePlaybook(editing.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        template: template.trim(),
        autoMapLabels,
      });
    } else {
      useStore.getState().addPlaybook({
        id: `pb-${Date.now()}`,
        name: name.trim(),
        description: description.trim() || undefined,
        template: template.trim(),
        autoMapLabels,
      });
    }

    setEditing(null);
    setCreating(false);
    resetForm();
  }

  function handleDelete(id: string) {
    useStore.getState().deletePlaybook(id);
    if (editing?.id === id) {
      setEditing(null);
      resetForm();
    }
  }

  function addLabel() {
    const val = labelInput.trim();
    if (val && !autoMapLabels.includes(val)) {
      setAutoMapLabels([...autoMapLabels, val]);
    }
    setLabelInput("");
  }

  const showEditor = editing || creating;

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-cc-bg rounded-[14px] shadow-lg w-full max-w-3xl max-h-[80vh] flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: list */}
        <div className="w-56 shrink-0 bg-cc-sidebar border-r border-cc-border flex flex-col">
          <div className="p-3 border-b border-cc-border">
            <h2 className="text-sm font-semibold text-cc-fg">Playbooks</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {playbooks.map((pb) => (
              <button
                key={pb.id}
                onClick={() => handleEdit(pb)}
                className={`w-full px-3 py-2 text-left rounded-lg transition-colors mb-0.5 cursor-pointer ${
                  editing?.id === pb.id ? "bg-cc-active" : "hover:bg-cc-hover"
                }`}
              >
                <div className="text-xs font-medium text-cc-fg truncate">{pb.name}</div>
                {pb.description && (
                  <div className="text-[10px] text-cc-muted mt-0.5 truncate">{pb.description}</div>
                )}
              </button>
            ))}
            {playbooks.length === 0 && (
              <p className="px-3 py-6 text-xs text-cc-muted text-center">No playbooks yet</p>
            )}
          </div>
          <div className="p-2 border-t border-cc-border">
            <button
              onClick={handleCreate}
              className="w-full py-2 px-3 text-xs font-medium rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
            >
              + New Playbook
            </button>
          </div>
        </div>

        {/* Right: editor */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="p-3 border-b border-cc-border flex justify-between items-center">
            <h3 className="text-sm font-semibold text-cc-fg">
              {creating ? "New Playbook" : editing ? editing.name : "Select a playbook"}
            </h3>
            <button
              onClick={onClose}
              className="text-xs text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>

          {showEditor ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Name */}
              <label className="block">
                <span className="text-xs font-medium text-cc-fg">Name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50"
                  placeholder="Bug Fix, Feature Request, etc."
                />
              </label>

              {/* Description */}
              <label className="block">
                <span className="text-xs font-medium text-cc-fg">Description (optional)</span>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 mt-1 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50"
                  placeholder="Short description"
                />
              </label>

              {/* Auto-map labels */}
              <div>
                <span className="text-xs font-medium text-cc-fg">Auto-suggest for labels</span>
                <div className="flex gap-2 mt-1">
                  <input
                    type="text"
                    value={labelInput}
                    onChange={(e) => setLabelInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addLabel();
                      }
                    }}
                    className="flex-1 px-3 py-2 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg focus:outline-none focus:border-cc-primary/50"
                    placeholder="Type label name, press Enter"
                  />
                </div>
                {autoMapLabels.length > 0 && (
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {autoMapLabels.map((label) => (
                      <span
                        key={label}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-cc-primary/10 text-cc-primary"
                      >
                        {label}
                        <button
                          onClick={() => setAutoMapLabels(autoMapLabels.filter((l) => l !== label))}
                          className="hover:text-cc-error cursor-pointer"
                        >
                          x
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Template */}
              <label className="block">
                <span className="text-xs font-medium text-cc-fg">Template</span>
                <p className="text-[11px] text-cc-muted mt-1 mb-2">
                  Placeholders: {"{{issue.identifier}}"}, {"{{issue.title}}"}, {"{{issue.description}}"}, {"{{issue.url}}"}, {"{{issue.state}}"}, {"{{issue.priority}}"}, {"{{issue.labels}}"}, {"{{issue.assignee}}"}
                </p>
                <textarea
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg bg-cc-input-bg border border-cc-border text-cc-fg font-mono-code resize-none focus:outline-none focus:border-cc-primary/50"
                  rows={10}
                  placeholder={`Fix the bug described in {{issue.identifier}}: {{issue.title}}\n\nDetails:\n{{issue.description}}\n\nLinear issue: {{issue.url}}`}
                />
              </label>

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleSave}
                  disabled={!name.trim() || !template.trim()}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {editing ? "Save Changes" : "Create Playbook"}
                </button>
                {editing && (
                  <button
                    onClick={() => handleDelete(editing.id)}
                    className="px-4 py-2 text-xs font-medium rounded-lg text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-cc-muted">Select a playbook to edit or create a new one</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
