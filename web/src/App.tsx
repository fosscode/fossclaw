import { useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "./store.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatView } from "./components/ChatView.js";
import { TopBar } from "./components/TopBar.js";
import { HomePage } from "./components/HomePage.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { Playground } from "./components/Playground.js";
import { PlaybookSelector } from "./components/PlaybookSelector.js";
import { PlaybookManager } from "./components/PlaybookManager.js";
import { VersionBadge } from "./components/VersionBadge.js";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts.js";
import { Settings } from "./components/Settings.js";
import { Login } from "./components/Login.js";
import { api } from "./api.js";
import type { Playbook } from "./types.js";
import { renderTemplate, buildDefaultContext } from "./utils/playbook.js";

function useHash() {
  return useSyncExternalStore(
    (cb) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); },
    () => window.location.hash,
  );
}

export default function App() {
  const darkMode = useStore((s) => s.darkMode);
  const colorTheme = useStore((s) => s.colorTheme);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const homeResetKey = useStore((s) => s.homeResetKey);
  const linearSelectedIssue = useStore((s) => s.linearSelectedIssue);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const hash = useHash();

  const [showPlaybookSelector, setShowPlaybookSelector] = useState(false);
  const showPlaybookManager = useStore((s) => s.showPlaybookManager);
  const setShowPlaybookManager = useStore((s) => s.setShowPlaybookManager);

  const [authChecked, setAuthChecked] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Check auth status on mount
  useEffect(() => {
    async function checkAuth() {
      try {
        const status = await api.getAuthStatus();
        setAuthRequired(status.authEnabled);
        if (!status.authEnabled) {
          setIsAuthenticated(true);
        } else {
          // Try to fetch sessions to test if we're authenticated
          try {
            await api.listSessions();
            setIsAuthenticated(true);
          } catch {
            setIsAuthenticated(false);
          }
        }
      } catch {
        // If auth check fails, assume no auth required
        setAuthRequired(false);
        setIsAuthenticated(true);
      } finally {
        setAuthChecked(true);
      }
    }
    checkAuth();
  }, []);

  // Load preferences from server on mount (after auth)
  useEffect(() => {
    if (isAuthenticated) {
      useStore.getState().loadPreferences();
    }
  }, [isAuthenticated]);

  // Request notification permission on mount
  useEffect(() => {
    if (isAuthenticated) {
      import("./utils/notifications.js").then(({ requestNotificationPermission }) => {
        requestNotificationPermission();
      });
    }
  }, [isAuthenticated]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    // Remove all theme classes
    document.documentElement.classList.remove(
      "theme-aurora",
      "theme-ocean",
      "theme-sunset",
      "theme-forest",
      "theme-lavender",
      "theme-rose"
    );
    // Add current theme class if in dark mode
    if (darkMode) {
      document.documentElement.classList.add(`theme-${colorTheme}`);
    }
  }, [darkMode, colorTheme]);

  // Show playbook selector when a Linear issue is selected
  useEffect(() => {
    if (linearSelectedIssue) {
      setShowPlaybookSelector(true);
    }
  }, [linearSelectedIssue]);

  function handlePlaybookSelected(playbook: Playbook | null) {
    if (!linearSelectedIssue) return;
    const text = playbook
      ? renderTemplate(playbook.template, linearSelectedIssue)
      : buildDefaultContext(linearSelectedIssue);

    const store = useStore.getState();
    store.setPrefilledText(text);
    store.setPrefilledIssue(linearSelectedIssue);
    store.setLinearSelectedIssue(null);
    store.setCurrentSession(null);
    setShowPlaybookSelector(false);
  }

  function handlePlaybookCancel() {
    useStore.getState().setLinearSelectedIssue(null);
    setShowPlaybookSelector(false);
  }

  // Show loading while checking auth
  if (!authChecked) {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-cc-bg">
        <div className="text-cc-fg/60">Loading...</div>
      </div>
    );
  }

  // Show login if auth is required and user is not authenticated
  if (authRequired && !isAuthenticated) {
    return <Login onSuccess={() => setIsAuthenticated(true)} />;
  }

  if (hash === "#/playground") {
    return <Playground />;
  }

  return (
    <div className="h-[100dvh] flex font-sans-ui bg-cc-bg text-cc-fg antialiased">
      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-30 md:hidden"
          onClick={() => useStore.getState().setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — overlay on mobile, inline on desktop */}
      <div
        className={`
          fixed md:relative z-40 md:z-auto
          h-full shrink-0 transition-[transform] duration-200
          ${sidebarOpen ? "translate-x-0" : "w-0 -translate-x-full md:translate-x-0"}
          overflow-hidden
        `}
        style={sidebarOpen ? { width: sidebarWidth } : undefined}
      >
        <Sidebar />
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar />
        <div className="flex-1 overflow-hidden">
          {currentSessionId ? (
            <ChatView sessionId={currentSessionId} />
          ) : (
            <HomePage key={homeResetKey} />
          )}
        </div>
      </div>

      {/* Playbook selector modal */}
      {showPlaybookSelector && linearSelectedIssue && (
        <PlaybookSelector
          issue={linearSelectedIssue}
          onSelect={handlePlaybookSelected}
          onCancel={handlePlaybookCancel}
          onManage={() => {
            setShowPlaybookSelector(false);
            setShowPlaybookManager(true);
          }}
        />
      )}

      {/* Playbook manager modal */}
      {showPlaybookManager && (
        <PlaybookManager onClose={() => setShowPlaybookManager(false)} />
      )}

      <VersionBadge />
      <KeyboardShortcuts />
      {useStore((s) => s.showSettings) && (
        <Settings onClose={() => useStore.getState().setShowSettings(false)} />
      )}

      {/* Task panel — overlay on mobile, inline on desktop */}
      {currentSessionId && (
        <>
          {/* Mobile overlay backdrop */}
          {taskPanelOpen && (
            <div
              className="fixed inset-0 bg-black/30 z-30 lg:hidden"
              onClick={() => useStore.getState().setTaskPanelOpen(false)}
            />
          )}

          <div
            className={`
              fixed lg:relative z-40 lg:z-auto right-0 top-0
              h-full shrink-0 transition-all duration-200
              ${taskPanelOpen ? "w-[280px] translate-x-0" : "w-0 translate-x-full lg:translate-x-0"}
              overflow-hidden
            `}
          >
            <TaskPanel sessionId={currentSessionId} />
          </div>
        </>
      )}
    </div>
  );
}
