import { useState } from "react";
import { useStore } from "../store.js";

const themes = [
  {
    id: "aurora" as const,
    name: "Aurora",
    description: "Cyan & Purple",
    colors: ["#06b6d4", "#8b5cf6", "#14b8a6"],
  },
  {
    id: "ocean" as const,
    name: "Ocean",
    description: "Blue & Aqua",
    colors: ["#3b82f6", "#0ea5e9", "#06b6d4"],
  },
  {
    id: "sunset" as const,
    name: "Sunset",
    description: "Orange & Pink",
    colors: ["#f97316", "#ec4899", "#a855f7"],
  },
  {
    id: "forest" as const,
    name: "Forest",
    description: "Green & Emerald",
    colors: ["#10b981", "#14b8a6", "#84cc16"],
  },
  {
    id: "lavender" as const,
    name: "Lavender",
    description: "Purple & Violet",
    colors: ["#a855f7", "#d946ef", "#8b5cf6"],
  },
  {
    id: "rose" as const,
    name: "Rose",
    description: "Pink & Red",
    colors: ["#f43f5e", "#ec4899", "#e11d48"],
  },
];

export function ThemeSelector() {
  const [isOpen, setIsOpen] = useState(false);
  const colorTheme = useStore((s) => s.colorTheme);
  const setColorTheme = useStore((s) => s.setColorTheme);

  const currentTheme = themes.find((t) => t.id === colorTheme) || themes[0];

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <div className="flex gap-1">
          {currentTheme.colors.map((color, i) => (
            <div
              key={i}
              className="w-3.5 h-3.5 rounded-full ring-1 ring-black/20"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
        <span className="flex-1 text-left">{currentTheme.name}</span>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`w-3 h-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute bottom-full left-0 right-0 mb-2 bg-cc-card border border-cc-border rounded-xl shadow-2xl z-50 overflow-hidden">
            <div className="p-2 space-y-1">
              {themes.map((theme) => (
                <button
                  key={theme.id}
                  onClick={() => {
                    setColorTheme(theme.id);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all cursor-pointer ${
                    colorTheme === theme.id
                      ? "bg-cc-active"
                      : "hover:bg-cc-hover"
                  }`}
                >
                  <div className="flex gap-1">
                    {theme.colors.map((color, i) => (
                      <div
                        key={i}
                        className="w-4 h-4 rounded-full ring-1 ring-black/20 shadow-sm"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                  <div className="flex-1 text-left">
                    <div className="text-sm font-medium text-cc-fg">
                      {theme.name}
                    </div>
                    <div className="text-xs text-cc-muted">
                      {theme.description}
                    </div>
                  </div>
                  {colorTheme === theme.id && (
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      className="w-4 h-4 text-cc-primary"
                    >
                      <path d="M3 8l3 3 7-7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
