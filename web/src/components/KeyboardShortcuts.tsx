import { useState } from "react";
import { useStore } from "../store.js";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts.js";
import { disconnectSession, connectSession } from "../ws.js";

/**
 * Global keyboard shortcuts manager
 * Handles app-wide keyboard shortcuts and shortcuts help modal
 */
export function KeyboardShortcuts() {
  const showHelp = useStore((s) => s.showKeyboardShortcuts);
  const setShowHelp = useStore((s) => s.setShowKeyboardShortcuts);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);

  // Build session list matching sidebar order (sorted by createdAt desc)
  const allSessionIds = new Set<string>();
  for (const id of sessions.keys()) allSessionIds.add(id);
  for (const s of sdkSessions) allSessionIds.add(s.sessionId);

  const sessionList = Array.from(allSessionIds)
    .map((id) => {
      const bridgeState = sessions.get(id);
      const sdkInfo = sdkSessions.find((s) => s.sessionId === id);
      return {
        id,
        createdAt: sdkInfo?.createdAt ?? 0,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => s.id);

  useKeyboardShortcuts([
    // Show keyboard shortcuts help
    {
      key: "/",
      ctrl: true,
      description: "Show keyboard shortcuts",
      handler: () => setShowHelp(true),
      global: true,
    },

    // Navigation
    {
      key: "b",
      ctrl: true,
      description: "Toggle sidebar",
      handler: () => setSidebarOpen(!sidebarOpen),
      global: true,
    },
    {
      key: "t",
      ctrl: true,
      description: "Toggle task panel",
      handler: () => setTaskPanelOpen(!taskPanelOpen),
      global: true,
    },
    {
      key: "h",
      ctrl: true,
      description: "Go to home",
      handler: () => {
        if (currentSessionId) {
          disconnectSession(currentSessionId);
        }
        setCurrentSession(null);
      },
      global: true,
    },
    {
      key: "n",
      ctrl: true,
      description: "New session",
      handler: () => {
        if (currentSessionId) {
          disconnectSession(currentSessionId);
        }
        useStore.getState().newSession();
      },
      global: true,
    },

    // Session cycling
    {
      key: "[",
      ctrl: true,
      description: "Previous session",
      handler: () => {
        if (sessionList.length === 0) return;
        const currentIdx = currentSessionId
          ? sessionList.indexOf(currentSessionId)
          : -1;
        const prevIdx = currentIdx <= 0 ? sessionList.length - 1 : currentIdx - 1;
        const prevSessionId = sessionList[prevIdx];
        if (prevSessionId) {
          if (currentSessionId) {
            disconnectSession(currentSessionId);
          }
          setCurrentSession(prevSessionId);
          connectSession(prevSessionId);
        }
      },
      global: true,
    },
    {
      key: "]",
      ctrl: true,
      description: "Next session",
      handler: () => {
        if (sessionList.length === 0) return;
        const currentIdx = currentSessionId
          ? sessionList.indexOf(currentSessionId)
          : -1;
        const nextIdx = (currentIdx + 1) % sessionList.length;
        const nextSessionId = sessionList[nextIdx];
        if (nextSessionId) {
          if (currentSessionId) {
            disconnectSession(currentSessionId);
          }
          setCurrentSession(nextSessionId);
          connectSession(nextSessionId);
        }
      },
      global: true,
    },

    // Direct session jumping (Ctrl+1 through Ctrl+9)
    ...Array.from({ length: 9 }, (_, i) => ({
      key: String(i + 1),
      ctrl: true,
      description: `Jump to session ${i + 1}`,
      handler: () => {
        const targetSessionId = sessionList[i];
        if (targetSessionId && targetSessionId !== currentSessionId) {
          if (currentSessionId) {
            disconnectSession(currentSessionId);
          }
          setCurrentSession(targetSessionId);
          connectSession(targetSessionId);
        }
      },
      global: true,
    })),

    // Quick actions
    {
      key: "Escape",
      description: "Close modals / Cancel actions",
      handler: () => {
        if (showHelp) {
          setShowHelp(false);
        }
      },
      global: true,
    },

    // Focus management
    {
      key: "i",
      ctrl: true,
      description: "Focus message input",
      handler: () => {
        const textarea = document.querySelector(
          'textarea[placeholder*="message"]'
        ) as HTMLTextAreaElement;
        textarea?.focus();
      },
      global: true,
    },
  ]);

  if (!showHelp) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={() => setShowHelp(false)}
    >
      <div
        className="bg-cc-bg rounded-[14px] shadow-lg w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-cc-border flex items-center justify-between shrink-0">
          <h2 className="text-lg font-semibold text-cc-fg">Keyboard Shortcuts</h2>
          <button
            onClick={() => setShowHelp(false)}
            className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          <ShortcutSection title="Navigation">
            <ShortcutItem keys={["Ctrl", "B"]} description="Toggle sidebar" />
            <ShortcutItem keys={["Ctrl", "T"]} description="Toggle task panel" />
            <ShortcutItem keys={["Ctrl", "H"]} description="Go to home" />
            <ShortcutItem keys={["Ctrl", "N"]} description="New session" />
            <ShortcutItem keys={["Ctrl", "["]} description="Previous session" />
            <ShortcutItem keys={["Ctrl", "]"]} description="Next session" />
            <ShortcutItem keys={["Ctrl", "1-9"]} description="Jump to session 1-9" />
          </ShortcutSection>

          <ShortcutSection title="Messaging">
            <ShortcutItem keys={["Ctrl", "I"]} description="Focus message input" />
            <ShortcutItem keys={["Enter"]} description="Send message" />
            <ShortcutItem keys={["Shift", "Enter"]} description="New line" />
            <ShortcutItem keys={["Shift", "Tab"]} description="Toggle mode (Plan/Agent)" />
            <ShortcutItem keys={["/"]} description="Open command menu" />
          </ShortcutSection>

          <ShortcutSection title="Home Page">
            <ShortcutItem keys={["Ctrl", "P"]} description="Toggle provider dropdown" />
            <ShortcutItem keys={["Ctrl", "M"]} description="Toggle model dropdown" />
          </ShortcutSection>

          <ShortcutSection title="General">
            <ShortcutItem keys={["Ctrl", "/"]} description="Show this help" />
            <ShortcutItem keys={["Escape"]} description="Close modals / Cancel" />
          </ShortcutSection>

          <ShortcutSection title="Browser Extensions">
            <div className="text-xs text-cc-muted space-y-2">
              <p>
                This interface works with keyboard navigation extensions like{" "}
                <span className="font-medium text-cc-fg">Vimium</span> and{" "}
                <span className="font-medium text-cc-fg">Surfingkeys</span>.
              </p>
              <p>
                All interactive elements (buttons, links, inputs) are properly marked up with
                ARIA attributes and work with standard browser accessibility features.
              </p>
              <div className="mt-3 p-3 bg-cc-hover rounded-lg">
                <p className="font-medium text-cc-fg mb-1">Recommended Vimium settings:</p>
                <ul className="list-disc list-inside space-y-1 text-[11px]">
                  <li>Enable "Use the link characters for link hints mode"</li>
                  <li>Exclude shortcuts on this domain if needed</li>
                </ul>
              </div>
            </div>
          </ShortcutSection>
        </div>
      </div>
    </div>
  );
}

function ShortcutSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6 last:mb-0">
      <h3 className="text-sm font-semibold text-cc-fg mb-3">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function ShortcutItem({
  keys,
  description,
}: {
  keys: string[];
  description: string;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-cc-muted">{description}</span>
      <div className="flex items-center gap-1">
        {keys.map((key, i) => (
          <span key={i}>
            <kbd className="px-2 py-1 text-xs font-mono-code bg-cc-hover border border-cc-border rounded shadow-sm text-cc-fg">
              {key}
            </kbd>
            {i < keys.length - 1 && (
              <span className="mx-1 text-cc-muted">+</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
