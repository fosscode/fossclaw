import { useState, useRef, useEffect, useCallback } from "react";
import { useStore } from "../store.js";
import { api, type DirEntry, type OpenCodeModel } from "../api.js";
import { connectSession, waitForConnection, sendToSession } from "../ws.js";
import { disconnectSession } from "../ws.js";
import { generateUniqueSessionName } from "../utils/names.js";
import { SearchableDropdown } from "./SearchableDropdown.js";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts.js";

interface ImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

function readFileAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ base64, mediaType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const MODELS = [
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6", icon: "\u25D0" },
  { value: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5", icon: "\u25D0" },
  { value: "claude-opus-4-6", label: "Opus", icon: "\u2733" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku", icon: "\u26A1" },
];

const MODES = [
  { value: "bypassPermissions", label: "Agent" },
  { value: "plan", label: "Plan" },
];

// recentDirs now managed via Zustand store (synced to server)

let idCounter = 0;

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function HomePage() {
  const prefilledText = useStore((s) => s.prefilledText);
  const prefilledIssue = useStore((s) => s.prefilledIssue);
  const recentDirs = useStore((s) => s.recentDirs);
  const addRecentDir = useStore((s) => s.addRecentDir);
  const defaultModels = useStore((s) => s.defaultModels);
  const setDefaultModel = useStore((s) => s.setDefaultModel);
  const homeProvider = useStore((s) => s.homeProvider);
  const [text, setText] = useState(prefilledText || "");
  const [provider, setProvider] = useState<"claude" | "opencode">(homeProvider);
  const [model, setModel] = useState(defaultModels.get("claude") || MODELS[0].value);
  const [ocModel, setOcModel] = useState(defaultModels.get("opencode") || "");
  const [ocModels, setOcModels] = useState<OpenCodeModel[]>([]);
  const [ocModelsLoading, setOcModelsLoading] = useState(false);
  const [mode, setMode] = useState(MODES[0].value);
  const [cwd, setCwd] = useState(() => recentDirs[0] || "");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dropdown states
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [showDirDropdown, setShowDirDropdown] = useState(false);
  const [showPlaybookDropdown, setShowPlaybookDropdown] = useState(false);
  const [showProviderDropdown, setShowProviderDropdown] = useState(false);
  const [browsePath, setBrowsePath] = useState("");
  const [browseDirs, setBrowseDirs] = useState<DirEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [dirInput, setDirInput] = useState("");
  const [showDirInput, setShowDirInput] = useState(false);
  const [showResumeDropdown, setShowResumeDropdown] = useState(false);
  const [claudeSessions, setClaudeSessions] = useState<Array<{ sessionId: string; cwd: string; lastModified: number }>>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const dirDropdownRef = useRef<HTMLDivElement>(null);
  const playbookDropdownRef = useRef<HTMLDivElement>(null);
  const providerDropdownRef = useRef<HTMLDivElement>(null);
  const resumeDropdownRef = useRef<HTMLDivElement>(null);

  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const playbooks = useStore((s) => s.playbooks);

  // Auto-focus textarea
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Sync provider from store (when navigated from sidebar)
  useEffect(() => {
    setProvider(homeProvider);
  }, [homeProvider]);

  // Keyboard shortcuts for provider and model selection
  useKeyboardShortcuts([
    {
      key: "p",
      ctrl: true,
      description: "Toggle provider dropdown",
      handler: () => {
        setShowProviderDropdown((prev) => !prev);
      },
      global: true,
    },
    {
      key: "m",
      ctrl: true,
      description: "Toggle model dropdown",
      handler: () => {
        setShowModelDropdown((prev) => !prev);
      },
      global: true,
    },
  ]);

  // Load OpenCode models when provider changes
  useEffect(() => {
    if (provider !== "opencode") return;
    if (ocModels.length > 0) return; // already loaded
    setOcModelsLoading(true);
    api.listOpenCodeModels()
      .then((r) => {
        setOcModels(r.models);
        const defaultOcModel = defaultModels.get("opencode");
        const defaultExists = r.models.some((m) => m.id === defaultOcModel);
        if (defaultExists && defaultOcModel) {
          setOcModel(defaultOcModel);
        } else if (r.models.length > 0 && !ocModel) {
          setOcModel(r.models[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setOcModelsLoading(false));
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshOcModels = useCallback(() => {
    if (provider !== "opencode") return;
    setOcModelsLoading(true);
    api.listOpenCodeModels()
      .then((r) => {
        setOcModels(r.models);
        const defaultOcModel = defaultModels.get("opencode");
        const defaultExists = r.models.some((m) => m.id === defaultOcModel);
        if (defaultExists && defaultOcModel) {
          setOcModel(defaultOcModel);
        } else if (r.models.length > 0 && !ocModel) {
          setOcModel(r.models[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setOcModelsLoading(false));
  }, [provider, ocModel, defaultModels]);

  // Update model when provider changes and default exists
  useEffect(() => {
    if (provider === "claude") {
      const defaultClaudeModel = defaultModels.get("claude");
      if (defaultClaudeModel) {
        setModel(defaultClaudeModel);
      }
    } else if (provider === "opencode") {
      const defaultOcModel = defaultModels.get("opencode");
      if (defaultOcModel && ocModels.some((m) => m.id === defaultOcModel)) {
        setOcModel(defaultOcModel);
      }
    }
  }, [provider, defaultModels, ocModels]);

  // Load server home/cwd on mount
  useEffect(() => {
    api.getHome().then(({ home, cwd: serverCwd }) => {
      if (!cwd) {
        setCwd(serverCwd || home);
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
        setShowModeDropdown(false);
      }
      if (dirDropdownRef.current && !dirDropdownRef.current.contains(e.target as Node)) {
        setShowDirDropdown(false);
        setShowDirInput(false);
      }
      if (playbookDropdownRef.current && !playbookDropdownRef.current.contains(e.target as Node)) {
        setShowPlaybookDropdown(false);
      }
      if (providerDropdownRef.current && !providerDropdownRef.current.contains(e.target as Node)) {
        setShowProviderDropdown(false);
      }
      if (resumeDropdownRef.current && !resumeDropdownRef.current.contains(e.target as Node)) {
        setShowResumeDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const loadDirs = useCallback(async (path?: string) => {
    setBrowseLoading(true);
    try {
      const result = await api.listDirs(path);
      setBrowsePath(result.path);
      setBrowseDirs(result.dirs);
    } catch {
      setBrowseDirs([]);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const loadClaudeSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const result = await api.listClaudeSessions();
      setClaudeSessions(result.sessions);
    } catch {
      setClaudeSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  async function handleResumeSession(sessionId: string, sessionCwd: string) {
    setSending(true);
    setError("");

    try {
      // Disconnect current session if any
      if (currentSessionId) {
        disconnectSession(currentSessionId);
      }

      // Create session with --resume flag
      const result = await api.createSession({
        resumeSessionId: sessionId,
        cwd: sessionCwd,
        provider: "claude",
      });
      const newSessionId = result.sessionId;

      // Assign a session name
      const existingNames = new Set(useStore.getState().sessionNames.values());
      const sessionName = generateUniqueSessionName(existingNames);
      useStore.getState().setSessionName(newSessionId, `Resume: ${sessionName}`);

      // Switch to session
      setCurrentSession(newSessionId);
      connectSession(newSessionId);
      setShowResumeDropdown(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  }

  const selectedModel = MODELS.find((m) => m.value === model) || MODELS[0];
  const selectedMode = MODES.find((m) => m.value === mode) || MODES[0];
  const dirLabel = cwd ? cwd.split("/").pop() || cwd : "Select folder";

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const newImages: ImageAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: file.name, base64, mediaType });
    }
    setImages((prev) => [...prev, ...newImages]);
    e.target.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImages: ImageAttachment[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: `pasted-${Date.now()}.${file.type.split("/")[1]}`, base64, mediaType });
    }
    if (newImages.length > 0) {
      e.preventDefault();
      setImages((prev) => [...prev, ...newImages]);
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 300) + "px";
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      setMode(mode === "plan" ? "bypassPermissions" : "plan");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSend() {
    const msg = text.trim();
    if (!msg || sending) return;

    setSending(true);
    setError("");

    try {
      // Disconnect current session if any
      if (currentSessionId) {
        disconnectSession(currentSessionId);
      }

      // Create session
      const selectedOcModel = ocModels.find((m) => m.id === ocModel);
      const result = await api.createSession({
        model: provider === "opencode" ? ocModel : model,
        permissionMode: provider === "claude" ? mode : undefined,
        provider,
        providerID: provider === "opencode" ? selectedOcModel?.providerID : undefined,
        cwd: cwd || undefined,
      });
      const sessionId = result.sessionId;

      // Assign a random session name
      const existingNames = new Set(useStore.getState().sessionNames.values());
      const sessionName = generateUniqueSessionName(existingNames);
      useStore.getState().setSessionName(sessionId, sessionName);

      // Save cwd to recent dirs
      if (cwd) addRecentDir(cwd);

      // Store the permission mode for this session
      useStore.getState().setPreviousPermissionMode(sessionId, mode);

      // Switch to session
      setCurrentSession(sessionId);
      connectSession(sessionId);

      // Wait for WebSocket connection
      await waitForConnection(sessionId);

      // Send message
      sendToSession(sessionId, {
        type: "user_message",
        content: msg,
        session_id: sessionId,
        images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
      });

      // Add user message to store
      useStore.getState().appendMessage(sessionId, {
        id: `user-${Date.now()}-${++idCounter}`,
        role: "user",
        content: msg,
        images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
        timestamp: Date.now(),
      });

      // Clear prefill state
      useStore.getState().clearPrefill();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  }

  const canSend = text.trim().length > 0 && !sending;

  return (
    <div className="flex-1 h-full flex items-center justify-center px-3 sm:px-4">
      <div className="w-full max-w-2xl">
        {/* Logo and Resume button */}
        <div className="flex items-center justify-center gap-3 mb-4 sm:mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cc-primary to-purple-600 flex items-center justify-center shadow-lg">
            <svg viewBox="0 0 32 32" fill="none" className="w-6 h-6 text-white">
              <path d="M16 4C16 4 12 8 12 12C12 14.2091 13.7909 16 16 16C18.2091 16 20 14.2091 20 12C20 8 16 4 16 4Z" fill="currentColor"/>
              <path d="M8 10C8 10 4 14 4 18C4 20.2091 5.79086 22 8 22C10.2091 22 12 20.2091 12 18C12 14 8 10 8 10Z" fill="currentColor" opacity="0.8"/>
              <path d="M24 10C24 10 20 14 20 18C20 20.2091 21.7909 22 24 22C26.2091 22 28 20.2091 28 18C28 14 24 10 24 10Z" fill="currentColor" opacity="0.8"/>
              <path d="M16 18C16 18 12 22 12 26C12 28.2091 13.7909 30 16 30C18.2091 30 20 28.2091 20 26C20 22 16 18 16 18Z" fill="currentColor" opacity="0.6"/>
            </svg>
          </div>
          {/* Resume session button */}
          <div className="relative" ref={resumeDropdownRef}>
            <button
              onClick={() => {
                if (!showResumeDropdown) {
                  setShowResumeDropdown(true);
                  loadClaudeSessions();
                } else {
                  setShowResumeDropdown(false);
                }
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer border border-cc-border"
              title="Resume a previous Claude session"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M8 3a5 5 0 104.546 2.914.5.5 0 00-.908-.417A4 4 0 118 4v1l1.5-1L8 2.5V3z" />
              </svg>
              <span>Resume</span>
            </button>
            {showResumeDropdown && (
              <div className="absolute left-0 top-full mt-1 w-96 max-w-[calc(100vw-2rem)] max-h-[400px] flex flex-col bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 overflow-hidden">
                <div className="px-3 py-2 border-b border-cc-border shrink-0">
                  <div className="text-xs font-medium text-cc-fg">Resume Claude Session</div>
                  <div className="text-[10px] text-cc-muted mt-0.5">Pick a previous session to continue</div>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {sessionsLoading ? (
                    <div className="px-3 py-8 text-xs text-cc-muted text-center">Loading sessions...</div>
                  ) : claudeSessions.length === 0 ? (
                    <div className="px-3 py-8 text-xs text-cc-muted text-center">No saved sessions found</div>
                  ) : (
                    claudeSessions.map((s) => {
                      const dirName = s.cwd.split("/").pop() || s.cwd;
                      const timeAgo = formatTimeAgo(s.lastModified);
                      return (
                        <button
                          key={s.sessionId}
                          onClick={() => handleResumeSession(s.sessionId, s.cwd)}
                          className="w-full px-3 py-2.5 text-left hover:bg-cc-hover transition-colors cursor-pointer border-b border-cc-border last:border-b-0"
                        >
                          <div className="flex items-center gap-2">
                            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted shrink-0">
                              <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                            </svg>
                            <span className="text-xs font-medium text-cc-fg truncate flex-1 font-mono-code">{dirName}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] text-cc-muted font-mono-code truncate flex-1">{s.sessionId.slice(0, 8)}</span>
                            <span className="text-[10px] text-cc-muted shrink-0">{timeAgo}</span>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Linear issue badge */}
        {prefilledIssue && (
          <div className="flex items-center gap-2 mb-2 px-1">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted shrink-0">
              <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
            </svg>
            <span className="text-xs text-cc-muted truncate flex-1">
              {prefilledIssue.identifier}: {prefilledIssue.title}
            </span>
            <button
              onClick={() => {
                setText("");
                useStore.getState().clearPrefill();
              }}
              className="text-xs text-cc-muted hover:text-cc-error transition-colors cursor-pointer shrink-0"
            >
              Clear
            </button>
          </div>
        )}

        {/* Image thumbnails */}
        {images.length > 0 && (
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.mediaType};base64,${img.base64}`}
                  alt={img.name}
                  className="w-12 h-12 rounded-lg object-cover border border-cc-border"
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Input card */}
        <div className="bg-cc-card border border-cc-border rounded-[14px] shadow-sm overflow-hidden">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Fix a bug, build a feature, refactor code..."
            rows={4}
            className="w-full px-4 pt-4 pb-2 text-sm bg-transparent resize-none focus:outline-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
            style={{ minHeight: "100px", maxHeight: "300px" }}
          />

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-3 pb-3">
            {/* Left: mode dropdown */}
            <div className="relative" ref={modeDropdownRef}>
              <button
                onClick={() => setShowModeDropdown(!showModeDropdown)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                  <path d="M2 4h12M2 8h8M2 12h10" strokeLinecap="round" />
                </svg>
                {selectedMode.label}
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
              {showModeDropdown && (
                <div className="absolute left-0 bottom-full mb-1 w-40 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                  {MODES.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => { setMode(m.value); setShowModeDropdown(false); }}
                      className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                        m.value === mode ? "text-cc-primary font-medium" : "text-cc-fg"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Right: image placeholder + send */}
            <div className="flex items-center gap-1.5">
              {/* Image upload */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                title="Upload image"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                  <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                  <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {/* Send button */}
              <button
                onClick={handleSend}
                disabled={!canSend}
                className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
                  canSend
                    ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                    : "bg-cc-hover text-cc-muted cursor-not-allowed"
                }`}
                title="Send message"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M3 2l11 6-11 6V9.5l7-1.5-7-1.5V2z" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Below-card selectors */}
        <div className="flex items-center gap-2 sm:gap-3 mt-2 sm:mt-3 px-1 flex-wrap">
          {/* Provider selector */}
          <div className="relative" ref={providerDropdownRef}>
            <button
              onClick={() => setShowProviderDropdown(!showProviderDropdown)}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <span>{provider === "claude" ? "\u2726" : "\u25C8"}</span>
              <span>{provider === "claude" ? "Claude" : "OpenCode"}</span>
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {showProviderDropdown && (
              <div className="absolute left-0 top-full mt-1 w-40 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                <button
                  onClick={() => { setProvider("claude"); setShowProviderDropdown(false); }}
                  className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                    provider === "claude" ? "text-cc-primary font-medium" : "text-cc-fg"
                  }`}
                >
                  <span>{"\u2726"}</span> Claude Code
                </button>
                <button
                  onClick={() => { setProvider("opencode"); setShowProviderDropdown(false); }}
                  className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                    provider === "opencode" ? "text-cc-primary font-medium" : "text-cc-fg"
                  }`}
                >
                  <span>{"\u25C8"}</span> OpenCode
                </button>
              </div>
            )}
          </div>

          {/* Folder selector */}
          <div className="relative" ref={dirDropdownRef}>
            <button
              onClick={() => {
                if (!showDirDropdown) {
                  setShowDirDropdown(true);
                  setShowDirInput(false);
                  loadDirs(cwd || undefined);
                } else {
                  setShowDirDropdown(false);
                }
              }}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
              <span className="max-w-[200px] truncate font-mono-code">{dirLabel}</span>
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {showDirDropdown && (
              <div className="absolute left-0 top-full mt-1 w-80 max-w-[calc(100vw-2rem)] max-h-[400px] flex flex-col bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 overflow-hidden">
                {/* Current path display + manual input toggle */}
                <div className="px-3 py-2 border-b border-cc-border flex items-center gap-2 shrink-0">
                  {showDirInput ? (
                    <input
                      type="text"
                      value={dirInput}
                      onChange={(e) => setDirInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && dirInput.trim()) {
                          setCwd(dirInput.trim());
                          addRecentDir(dirInput.trim());
                          setShowDirDropdown(false);
                          setShowDirInput(false);
                        }
                        if (e.key === "Escape") {
                          setShowDirInput(false);
                        }
                      }}
                      placeholder="/path/to/project"
                      className="flex-1 px-2 py-1 text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="text-[10px] text-cc-muted font-mono-code truncate flex-1">{browsePath}</span>
                      <button
                        onClick={() => { setShowDirInput(true); setDirInput(cwd); }}
                        className="text-[10px] text-cc-muted hover:text-cc-fg shrink-0 cursor-pointer"
                        title="Type path manually"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                          <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.098a.25.25 0 00-.064.108l-.563 1.97 1.971-.564a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354l-1.098-1.097z" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>

                {/* Directory browser */}
                {!showDirInput && (
                  <>
                    {/* Go up button */}
                    {browsePath && browsePath !== "/" && (
                      <button
                        onClick={() => {
                          const parent = browsePath.split("/").slice(0, -1).join("/") || "/";
                          loadDirs(parent);
                        }}
                        className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-muted"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-60">
                          <path d="M8 12l-4-4h2.5V4h3v4H12L8 12z" transform="rotate(180 8 8)" />
                        </svg>
                        <span>..</span>
                      </button>
                    )}

                    {/* Select current directory */}
                    <button
                      onClick={() => {
                        setCwd(browsePath);
                        addRecentDir(browsePath);
                        setShowDirDropdown(false);
                      }}
                      className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-primary font-medium border-b border-cc-border"
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
                        <path d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z" />
                      </svg>
                      <span className="truncate font-mono-code">Select: {browsePath.split("/").pop() || "/"}</span>
                    </button>

                    {/* Subdirectories */}
                    <div className="flex-1 min-h-0 overflow-y-auto">
                      {browseLoading ? (
                        <div className="px-3 py-3 text-xs text-cc-muted text-center">Loading...</div>
                      ) : browseDirs.length === 0 ? (
                        <div className="px-3 py-3 text-xs text-cc-muted text-center">No subdirectories</div>
                      ) : (
                        browseDirs.map((d) => (
                          <button
                            key={d.path}
                            onClick={() => loadDirs(d.path)}
                            onDoubleClick={() => {
                              setCwd(d.path);
                              addRecentDir(d.path);
                              setShowDirDropdown(false);
                            }}
                            className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer truncate font-mono-code flex items-center gap-2 text-cc-fg"
                          >
                            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-40 shrink-0">
                              <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                            </svg>
                            <span className="truncate">{d.name}</span>
                            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-30 shrink-0 ml-auto">
                              <path d="M6 4l4 4-4 4" />
                            </svg>
                          </button>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Model selector */}
          <div className="relative" ref={modelDropdownRef}>
            <button
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
            >
              {provider === "claude" ? (
                <>
                  <span>{selectedModel.icon}</span>
                  <span>{selectedModel.label}</span>
                </>
              ) : (
                <>
                  <span>{"\u25C8"}</span>
                  <span className="max-w-[150px] truncate">{ocModelsLoading ? "Loading..." : (ocModels.find((m) => m.id === ocModel)?.name || ocModel || "Select model")}</span>
                </>
              )}
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {showModelDropdown && (
              provider === "claude" ? (
                <SearchableDropdown
                  options={MODELS.map((m) => ({ value: m.value, label: m.label, icon: m.icon }))}
                  value={model}
                  onChange={setModel}
                  onClose={() => setShowModelDropdown(false)}
                  placeholder="Search models..."
                  width="240px"
                  footer={
                    <div className="px-3 py-2 flex items-center justify-between">
                      <span className="text-[10px] text-cc-muted">
                        {defaultModels.get("claude") === model ? "✓ Default" : ""}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDefaultModel("claude", model);
                          setShowModelDropdown(false);
                        }}
                        className="text-xs text-cc-primary hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-default disabled:no-underline"
                        disabled={defaultModels.get("claude") === model}
                      >
                        {defaultModels.get("claude") === model ? "Saved" : "Save as default"}
                      </button>
                    </div>
                  }
                />
              ) : ocModelsLoading ? (
                <div className="absolute left-0 top-full mt-1 w-[280px] bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1">
                  <div className="px-3 py-3 text-xs text-cc-muted text-center">Loading models...</div>
                </div>
              ) : ocModels.length === 0 ? (
                <div className="absolute left-0 top-full mt-1 w-[280px] bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1">
                  <div className="px-3 py-3 text-xs text-cc-muted text-center">No models available</div>
                  <div className="px-3 pb-3 flex justify-center">
                    <button
                      onClick={refreshOcModels}
                      className="text-xs text-cc-primary hover:underline cursor-pointer"
                    >
                      Refresh
                    </button>
                  </div>
                </div>
              ) : (
                <SearchableDropdown
                  options={ocModels.map((m) => ({ value: m.id, label: m.name, icon: "\u25C8", subtitle: m.providerID }))}
                  value={ocModel}
                  onChange={setOcModel}
                  onClose={() => setShowModelDropdown(false)}
                  placeholder="Search models..."
                  width="320px"
                  footer={
                    <div className="px-3 py-2 flex items-center justify-between">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          refreshOcModels();
                        }}
                        className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
                      >
                        ↻ Refresh
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDefaultModel("opencode", ocModel);
                          setShowModelDropdown(false);
                        }}
                        className="text-xs text-cc-primary hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-default disabled:no-underline"
                        disabled={defaultModels.get("opencode") === ocModel}
                      >
                        {defaultModels.get("opencode") === ocModel ? "Saved" : "Save as default"}
                      </button>
                    </div>
                  }
                />
              )
            )}
          </div>

          {/* Playbook selector */}
          <div className="relative" ref={playbookDropdownRef}>
            <button
              onClick={() => setShowPlaybookDropdown(!showPlaybookDropdown)}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-6a1 1 0 00-1 1v6.708A2.486 2.486 0 017.5 9h5V1.5z" />
              </svg>
              <span>Playbook</span>
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {showPlaybookDropdown && (
              <div className="absolute left-0 top-full mt-1 w-64 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 overflow-hidden">
                <div className="max-h-[300px] overflow-y-auto py-1">
                  {playbooks.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-cc-muted text-center">
                      No playbooks yet
                    </div>
                  ) : (
                    playbooks.map((pb) => (
                      <button
                        key={pb.id}
                        onClick={() => {
                          setText(pb.template);
                          setShowPlaybookDropdown(false);
                          // Auto-resize textarea
                          setTimeout(() => {
                            const ta = textareaRef.current;
                            if (ta) {
                              ta.style.height = "auto";
                              ta.style.height = Math.min(ta.scrollHeight, 300) + "px";
                              ta.focus();
                            }
                          }, 0);
                        }}
                        className="w-full px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
                      >
                        <div className="text-xs font-medium text-cc-fg">{pb.name}</div>
                        {pb.description && (
                          <div className="text-[11px] text-cc-muted mt-0.5 truncate">{pb.description}</div>
                        )}
                      </button>
                    ))
                  )}
                </div>
                <div className="border-t border-cc-border px-3 py-2">
                  <button
                    onClick={() => {
                      setShowPlaybookDropdown(false);
                      useStore.getState().setShowPlaybookManager(true);
                    }}
                    className="text-xs text-cc-primary hover:underline cursor-pointer"
                  >
                    Manage Playbooks
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-cc-error/5 border border-cc-error/20">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-error shrink-0">
              <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm1-3a1 1 0 11-2 0 1 1 0 012 0zM7.5 5.5a.5.5 0 011 0v3a.5.5 0 01-1 0v-3z" clipRule="evenodd" />
            </svg>
            <p className="text-xs text-cc-error">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
