import { useState, useRef, useEffect } from "react";

interface SearchableDropdownProps {
  options: Array<{ value: string; label: string; icon?: string; subtitle?: string }>;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  placeholder?: string;
  width?: string;
  footer?: React.ReactNode;
}

export function SearchableDropdown({
  options,
  value,
  onChange,
  onClose,
  placeholder = "Search...",
  width = "280px",
  footer,
}: SearchableDropdownProps) {
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter options based on search
  const filtered = options.filter((opt) => {
    const searchLower = search.toLowerCase();
    return (
      opt.label.toLowerCase().includes(searchLower) ||
      opt.value.toLowerCase().includes(searchLower) ||
      opt.subtitle?.toLowerCase().includes(searchLower)
    );
  });

  // Reset selected index when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        onChange(filtered[selectedIndex].value);
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="absolute left-0 top-full mt-1 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 overflow-hidden flex flex-col"
      style={{ width, maxHeight: "320px" }}
    >
      {/* Search input */}
      <div className="px-2 py-2 border-b border-cc-border shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full px-2 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
        />
      </div>

      {/* Options list */}
      <div ref={listRef} className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-3 text-xs text-cc-muted text-center">No matches</div>
        ) : (
          filtered.map((opt, idx) => {
            const isSelected = idx === selectedIndex;
            const isActive = opt.value === value;
            return (
              <button
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
                className={`w-full px-3 py-2 text-xs text-left transition-colors cursor-pointer ${
                  isSelected ? "bg-cc-hover" : ""
                } ${isActive ? "text-cc-primary font-medium" : "text-cc-fg"}`}
              >
                {opt.icon && opt.subtitle ? (
                  // Multi-line layout for OpenCode models
                  <>
                    <div className="truncate flex items-center gap-2">
                      <span>{opt.icon}</span>
                      {opt.label}
                    </div>
                    {opt.subtitle && (
                      <div className="text-[10px] text-cc-muted mt-0.5">{opt.subtitle}</div>
                    )}
                  </>
                ) : (
                  // Single-line layout for Claude models
                  <div className="flex items-center gap-2">
                    {opt.icon && <span>{opt.icon}</span>}
                    {opt.label}
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>

      {/* Optional footer */}
      {footer && (
        <div className="border-t border-cc-border shrink-0">
          {footer}
        </div>
      )}
    </div>
  );
}
