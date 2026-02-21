import { useState, useEffect, useCallback, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { connectSession, disconnectSession } from "../ws.js";
import { ThemeSelector } from "./ThemeSelector.js";
import { LinearIssueList } from "./LinearIssueList.js";
import { requestNotificationPermission } from "../utils/notifications.js";

function useSidebarResize() {
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = useStore.getState().sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMouseMove(ev: MouseEvent) {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      setSidebarWidth(startW.current + delta);
    }
    function onMouseUp() {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [setSidebarWidth]);

  return onMouseDown;
}

export function Sidebar() {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  const coderMode = useStore((s) => s.coderMode);
  const toggleCoderMode = useStore((s) => s.toggleCoderMode);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const removeSession = useStore((s) => s.removeSession);
  const sessionNames = useStore((s) => s.sessionNames);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const sessionContext = useStore((s) => s.sessionContext);
  const setSessionContext = useStore((s) => s.setSessionContext);
  const sidebarTab = useStore((s) => s.sidebarTab);
  const setSidebarTab = useStore((s) => s.setSidebarTab);

  // Poll for SDK sessions on mount
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const list = await api.listSessions();
        if (active) {
          useStore.getState().setSdkSessions(list);
          // Load session names from server (server is source of truth)
          const store = useStore.getState();
          for (const session of list) {
            if (session.sessionName) {
              store.setSessionNameLocal(session.sessionId, session.sessionName);
            }
            // Fetch context for OpenCode sessions
            if (session.provider === "opencode") {
              api.getSessionContext(session.sessionId)
                .then((ctx) => {
                  if (ctx.tokens && !ctx.error) {
                    setSessionContext(session.sessionId, ctx.tokens);
                  }
                })
                .catch(() => {
                  // Ignore errors (context may not be available)
                });
            }
          }
        }
      } catch {
        // server not ready
      }
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [setSessionContext]);

  function handleSelectSession(sessionId: string) {
    if (currentSessionId === sessionId) return;
    // Disconnect from old session, connect to new
    if (currentSessionId) {
      disconnectSession(currentSessionId);
    }
    setCurrentSession(sessionId);
    connectSession(sessionId);
    // Close sidebar on mobile
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function handleNewSession(provider: "claude" | "opencode" | "codex") {
    if (currentSessionId) {
      disconnectSession(currentSessionId);
    }
    useStore.getState().newSession(provider);
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  // Focus edit input when entering edit mode
  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [menuOpen]);

  function confirmRename() {
    if (editingSessionId && editingName.trim()) {
      useStore.getState().setSessionName(editingSessionId, editingName.trim());
    }
    setEditingSessionId(null);
    setEditingName("");
  }

  function cancelRename() {
    setEditingSessionId(null);
    setEditingName("");
  }

  const handleDeleteSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      disconnectSession(sessionId);
      await api.deleteSession(sessionId);
    } catch {
      // best-effort
    }
    removeSession(sessionId);
  }, [removeSession]);

  const handleResumeSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      const result = await api.resumeSession(sessionId);
      // Switch to the new session
      if (currentSessionId) {
        disconnectSession(currentSessionId);
      }
      setCurrentSession(result.newSessionId);
      connectSession(result.newSessionId);
      // Remove old session from UI
      removeSession(sessionId);
      // Close sidebar on mobile
      if (window.innerWidth < 768) {
        useStore.getState().setSidebarOpen(false);
      }
    } catch (err) {
      console.error("Failed to resume session:", err);
      useStore.getState().addToast(`Failed to resume session: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [currentSessionId, setCurrentSession, removeSession]);

  // Combine sessions from WsBridge state + SDK sessions list
  const allSessionIds = new Set<string>();
  for (const id of sessions.keys()) allSessionIds.add(id);
  for (const s of sdkSessions) allSessionIds.add(s.sessionId);

  const sessionList = Array.from(allSessionIds).map((id) => {
    const bridgeState = sessions.get(id);
    const sdkInfo = sdkSessions.find((s) => s.sessionId === id);
    return {
      id,
      model: bridgeState?.model || sdkInfo?.model || "",
      provider: sdkInfo?.provider ?? null,
      cwd: bridgeState?.cwd || sdkInfo?.cwd || "",
      isConnected: cliConnected.get(id) ?? false,
      status: sessionStatus.get(id) ?? null,
      sdkState: sdkInfo?.state ?? null,
      createdAt: sdkInfo?.createdAt ?? 0,
      archived: bridgeState?.archived || sdkInfo?.archived || false,
    };
  }).sort((a, b) => b.createdAt - a.createdAt);

  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const onResizeMouseDown = useSidebarResize();

  return (
    <aside className="h-full flex flex-col bg-cc-sidebar border-r border-cc-border relative" style={{ width: sidebarWidth }}>
      {/* Header */}
      <div className="p-4 pb-3">
        <div className="flex items-center justify-center mb-4">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cc-primary to-purple-600 flex items-center justify-center shadow-lg">
            <svg viewBox="0 0 32 32" fill="none" className="w-5 h-5 text-white">
              <path d="M16 4C16 4 12 8 12 12C12 14.2091 13.7909 16 16 16C18.2091 16 20 14.2091 20 12C20 8 16 4 16 4Z" fill="currentColor"/>
              <path d="M8 10C8 10 4 14 4 18C4 20.2091 5.79086 22 8 22C10.2091 22 12 20.2091 12 18C12 14 8 10 8 10Z" fill="currentColor" opacity="0.8"/>
              <path d="M24 10C24 10 20 14 20 18C20 20.2091 21.7909 22 24 22C26.2091 22 28 20.2091 28 18C28 14 24 10 24 10Z" fill="currentColor" opacity="0.8"/>
              <path d="M16 18C16 18 12 22 12 26C12 28.2091 13.7909 30 16 30C18.2091 30 20 28.2091 20 26C20 22 16 18 16 18Z" fill="currentColor" opacity="0.6"/>
            </svg>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <button
            onClick={() => handleNewSession("claude")}
            aria-label="Create new Claude session"
            className="py-1.5 px-2 text-xs font-medium rounded-[8px] bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors duration-150 flex items-center justify-center gap-1 cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 shrink-0">
              <path d="M8 3v10M3 8h10" />
            </svg>
            Claude
          </button>

          <button
            onClick={() => handleNewSession("opencode")}
            aria-label="Create new OpenCode session"
            className="py-1.5 px-2 text-xs font-medium rounded-[8px] bg-cc-bg-secondary hover:bg-cc-border text-cc-text-primary transition-colors duration-150 flex items-center justify-center gap-1 cursor-pointer border border-cc-border"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 shrink-0">
              <path d="M8 3v10M3 8h10" />
            </svg>
            OC
          </button>

          <button
            onClick={() => handleNewSession("codex")}
            aria-label="Create new Codex session"
            className="py-1.5 px-2 text-xs font-medium rounded-[8px] bg-cc-bg-secondary hover:bg-cc-border text-cc-text-primary transition-colors duration-150 flex items-center justify-center gap-1 cursor-pointer border border-cc-border"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 shrink-0">
              <path d="M8 3v10M3 8h10" />
            </svg>
            Codex
          </button>
        </div>

      </div>

      {/* Tab switcher when Linear is active */}
      {sidebarTab === "linear" && (
        <div className="flex px-2 gap-1 mb-1">
          <button
            onClick={() => setSidebarTab("sessions")}
            className="flex-1 py-1.5 text-xs font-medium rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            Sessions
          </button>
          <button
            className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-cc-active text-cc-fg cursor-default"
          >
            Linear
          </button>
        </div>
      )}

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sidebarTab === "linear" ? (
          <LinearIssueList />
        ) : sessionList.length === 0 ? (
          <p className="px-3 py-8 text-xs text-cc-muted text-center leading-relaxed">
            No sessions yet.
          </p>
        ) : (
          <div className="space-y-0.5">
            {sessionList.map((s, idx) => {
              const isActive = currentSessionId === s.id;
              const name = sessionNames.get(s.id);
              const shortId = s.id.slice(0, 8);
              const label = name || s.model || shortId;
              const dirName = s.cwd ? s.cwd.split("/").pop() : "";
              const isRunning = s.status === "running";
              const isCompacting = s.status === "compacting";
              const isEditing = editingSessionId === s.id;
              const permCount = pendingPermissions.get(s.id)?.size ?? 0;
              const showShortcut = idx < 9; // Show Ctrl+1-9 hints
              const context = sessionContext.get(s.id);

              return (
                <div key={s.id} className="relative group">
                  <button
                    onClick={() => handleSelectSession(s.id)}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      setEditingSessionId(s.id);
                      setEditingName(label);
                    }}
                    aria-label={`Session ${label}${isActive ? ' (active)' : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    tabIndex={0}
                    className={`w-full px-3 py-2.5 pr-8 text-left rounded-[10px] transition-all duration-100 cursor-pointer ${
                      isActive
                        ? "bg-cc-active"
                        : "hover:bg-cc-hover"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {showShortcut && (
                        <span className="text-[10px] font-medium text-cc-muted opacity-50 group-hover:opacity-70 transition-opacity w-3 shrink-0 text-center">
                          {idx + 1}
                        </span>
                      )}
                      <span className="relative flex shrink-0 w-3.5 h-3.5 items-center justify-center">
                        {s.archived ? (
                          // Archived session: show archive icon
                          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted opacity-60">
                            <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v1a1 1 0 01-1 1H3a1 1 0 01-1-1V3z" />
                            <path fillRule="evenodd" d="M13 6H3v7a1 1 0 001 1h8a1 1 0 001-1V6zM6 8.5a.5.5 0 01.5-.5h3a.5.5 0 010 1h-3a.5.5 0 01-.5-.5z" clipRule="evenodd" />
                          </svg>
                        ) : permCount > 0 ? (
                          // Permission pending: pulsing warning dot with ripple
                          <>
                            <span className="w-2.5 h-2.5 rounded-full bg-cc-warning animate-[pulse-scale_1.2s_ease-in-out_infinite]" />
                            <span className="absolute inset-0 m-auto w-2.5 h-2.5 rounded-full bg-cc-warning/40 animate-[ripple_1.5s_ease-out_infinite]" />
                          </>
                        ) : s.sdkState === "exited" || !s.isConnected ? (
                          // Disconnected/exited: dim static dot
                          <span className="w-2 h-2 rounded-full bg-cc-muted opacity-30" />
                        ) : isRunning ? (
                          // Running: spinning ring + solid center
                          <>
                            <span className="w-2 h-2 rounded-full bg-cc-running" />
                            <svg className="absolute inset-0 w-3.5 h-3.5 animate-[spin-ring_1.2s_linear_infinite]" viewBox="0 0 14 14" fill="none">
                              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="8 24" className="text-cc-running" />
                            </svg>
                            <span className="absolute inset-0 m-auto w-2.5 h-2.5 rounded-full bg-cc-running/20 animate-[ripple_2s_ease-out_infinite]" />
                          </>
                        ) : isCompacting ? (
                          // Compacting: pulsing warning with scale animation
                          <>
                            <span className="w-2.5 h-2.5 rounded-full bg-cc-warning animate-[pulse-scale_1.5s_ease-in-out_infinite]" />
                            <span className="absolute inset-0 m-auto w-2.5 h-2.5 rounded-full bg-cc-warning/30 animate-[ripple_2s_ease-out_infinite]" />
                          </>
                        ) : (
                          // Idle/connected: gentle breathing green dot
                          <span className="w-2.5 h-2.5 rounded-full bg-cc-success animate-[breathe_3s_ease-in-out_infinite]" />
                        )}
                      </span>
                      {isEditing ? (
                        <input
                          ref={editInputRef}
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              confirmRename();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelRename();
                            }
                            e.stopPropagation();
                          }}
                          onBlur={confirmRename}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          className="text-[13px] font-medium flex-1 text-cc-fg bg-transparent border border-cc-border rounded-md px-1 py-0 outline-none focus:border-cc-primary/50 min-w-0"
                        />
                      ) : (
                        <span className="text-[13px] font-medium truncate flex-1 text-cc-fg">
                          {label}
                        </span>
                      )}
                    </div>
                    {(dirName || s.provider || s.model || s.archived || (!s.archived && s.isConnected)) && (
                      <div className="mt-0.5 ml-5 flex items-center gap-1.5 flex-wrap">
                        {s.archived ? (
                          <span className="text-[10px] font-medium px-1.5 py-0 rounded-full border border-cc-muted/30 text-cc-muted">
                            Archived
                          </span>
                        ) : permCount > 0 ? (
                          <span className="text-[10px] font-medium text-cc-warning animate-pulse">
                            Waiting for input
                          </span>
                        ) : s.isConnected && isRunning ? (
                          <span className="text-[10px] font-medium text-cc-running">
                            Thinking...
                          </span>
                        ) : s.isConnected && isCompacting ? (
                          <span className="text-[10px] font-medium text-cc-warning animate-pulse">
                            Compacting...
                          </span>
                        ) : s.isConnected ? (
                          <span className="text-[10px] font-medium text-cc-success/70">
                            Ready
                          </span>
                        ) : s.sdkState === "exited" ? (
                          <span className="text-[10px] font-medium text-cc-muted/50">
                            Exited
                          </span>
                        ) : null}
                        {s.provider && (
                          <span className={`text-[10px] font-medium px-1.5 py-0 rounded-full border ${
                            s.provider === "claude"
                              ? "border-cc-primary/30 text-cc-primary"
                              : s.provider === "codex"
                              ? "border-green-500/30 text-green-500"
                              : "border-cc-running/30 text-cc-running"
                          }`}>
                            {s.provider === "claude" ? "Claude" : s.provider === "codex" ? "Codex" : "OpenCode"}
                          </span>
                        )}
                        {s.model && (
                          <span className="text-[10px] text-cc-muted truncate">
                            {s.model}
                          </span>
                        )}
                      </div>
                    )}
                    {dirName && (
                      <p className="text-[11px] text-cc-muted truncate mt-0.5 ml-5">
                        {dirName}
                      </p>
                    )}
                    {context && (
                      <div className="mt-0.5 ml-5 flex items-center gap-1">
                        <span className="text-[10px] text-cc-muted">
                          {context.used.toLocaleString()} / {context.max.toLocaleString()} tokens
                        </span>
                        <div className="flex-1 h-1 bg-cc-border rounded-full overflow-hidden max-w-[80px]">
                          <div
                            className={`h-full transition-all ${
                              context.used / context.max > 0.9 ? "bg-red-500" :
                              context.used / context.max > 0.7 ? "bg-yellow-500" :
                              "bg-cc-success"
                            }`}
                            style={{ width: `${Math.min(100, (context.used / context.max) * 100)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </button>
                  {permCount > 0 && (
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-cc-warning text-white text-[10px] font-bold leading-none px-1 group-hover:opacity-0 transition-opacity pointer-events-none">
                      {permCount}
                    </span>
                  )}
                  {s.archived ? (
                    // Archived sessions show resume and delete buttons
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => handleResumeSession(e, s.id)}
                        className="p-1 rounded-md hover:bg-cc-primary/10 text-cc-primary hover:text-cc-primary transition-all cursor-pointer"
                        title="Resume session"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                          <path d="M3 2.5A1.5 1.5 0 014.5 1h3A1.5 1.5 0 019 2.5v11A1.5 1.5 0 017.5 15h-3A1.5 1.5 0 013 13.5v-11zM12 8a.5.5 0 01.748-.434l2.5 1.5a.5.5 0 010 .868l-2.5 1.5A.5.5 0 0112 11V8z" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => handleDeleteSession(e, s.id)}
                        className="p-1 rounded-md hover:bg-cc-border text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
                        title="Delete session"
                      >
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                          <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    // Active sessions show only delete button
                    <button
                      onClick={(e) => handleDeleteSession(e, s.id)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
                      title="Delete session"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer: theme controls */}
      <div className="p-3 border-t border-cc-border space-y-1">
        <ThemeSelector />
        <button
          onClick={() => useStore.getState().setShowCronPanel(true)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
          </svg>
          <span>Cron Jobs</span>
        </button>
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
            </svg>
            <span>View Options</span>
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`w-4 h-4 ml-auto transition-transform ${menuOpen ? 'rotate-180' : ''}`}
            >
              <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>

          {menuOpen && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-cc-sidebar border border-cc-border rounded-[10px] shadow-lg overflow-hidden">
              <button
                onClick={() => {
                  toggleDarkMode();
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                {darkMode ? (
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                  </svg>
                )}
                <span>{darkMode ? "Light mode" : "Dark mode"}</span>
              </button>
              <button
                onClick={() => {
                  toggleCoderMode();
                  setMenuOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer ${
                  coderMode
                    ? "bg-cc-primary/10 text-cc-primary"
                    : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <path d="M4 5h12M4 10h12M4 15h8" />
                </svg>
                <span>Coder View</span>
                {coderMode && (
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 ml-auto">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => {
                  setSidebarTab(sidebarTab === "linear" ? "sessions" : "linear");
                  setMenuOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer ${
                  sidebarTab === "linear"
                    ? "bg-cc-primary/10 text-cc-primary"
                    : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h6a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
                </svg>
                <span>Linear Issues</span>
                {sidebarTab === "linear" && (
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 ml-auto">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
              <button
                onClick={async () => {
                  setMenuOpen(false);
                  const granted = await requestNotificationPermission();
                  if (granted) {
                    useStore.getState().addToast("Notifications enabled! You'll be notified when other sessions need input.", "success");
                  } else {
                    useStore.getState().addToast("Notifications were denied. Enable them in your browser settings.", "info");
                  }
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
                </svg>
                <span>Enable Notifications</span>
              </button>
              <button
                onClick={async () => {
                  setMenuOpen(false);
                  if (sessionList.length === 0) return;
                  const confirmed = confirm(`Delete all ${sessionList.length} sessions? This cannot be undone.`);
                  if (!confirmed) return;
                  // Delete all sessions
                  const sessionIds = sessionList.map(s => s.id);
                  for (const sessionId of sessionIds) {
                    try {
                      disconnectSession(sessionId);
                      await api.deleteSession(sessionId);
                    } catch {
                      // best-effort
                    }
                    removeSession(sessionId);
                  }
                  useStore.getState().addToast(`Deleted ${sessionIds.length} sessions`, "success");
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <span>Clear All Sessions</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onResizeMouseDown}
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-cc-primary/30 active:bg-cc-primary/50 transition-colors z-10"
      />
    </aside>
  );
}
