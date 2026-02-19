import { useState, useEffect } from "react";
import { useStore } from "../store";
import { api } from "../api";

export function Settings({ onClose }: { onClose: () => void }) {
  const darkMode = useStore((s) => s.darkMode);
  const setDarkMode = useStore((s) => s.setDarkMode);
  const coderMode = useStore((s) => s.coderMode);
  const setCoderMode = useStore((s) => s.setCoderMode);
  const notificationsEnabled = useStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useStore((s) => s.setNotificationsEnabled);
  const webhookUrl = useStore((s) => s.webhookUrl);
  const setWebhookUrl = useStore((s) => s.setWebhookUrl);
  const [webhookInput, setWebhookInput] = useState(webhookUrl);
  useEffect(() => { setWebhookInput(webhookUrl); }, [webhookUrl]);
  const appUrl = useStore((s) => s.appUrl);
  const setAppUrl = useStore((s) => s.setAppUrl);
  const [appUrlInput, setAppUrlInput] = useState(appUrl);
  useEffect(() => { setAppUrlInput(appUrl); }, [appUrl]);
  const ollamaUrl = useStore((s) => s.ollamaUrl);
  const setOllamaUrl = useStore((s) => s.setOllamaUrl);
  const [ollamaUrlInput, setOllamaUrlInput] = useState(ollamaUrl);
  useEffect(() => { setOllamaUrlInput(ollamaUrl); }, [ollamaUrl]);
  const ollamaModel = useStore((s) => s.ollamaModel);
  const setOllamaModel = useStore((s) => s.setOllamaModel);
  const [ollamaModelInput, setOllamaModelInput] = useState(ollamaModel);
  useEffect(() => { setOllamaModelInput(ollamaModel); }, [ollamaModel]);
  const [testStatus, setTestStatus] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [testError, setTestError] = useState<string>("");
  const [ollamaTestStatus, setOllamaTestStatus] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [ollamaTestError, setOllamaTestError] = useState<string>("");

  const [updateStatus, setUpdateStatus] = useState<{
    checking: boolean;
    updateAvailable: boolean;
    currentVersion?: string;
    latestVersion?: string;
    error?: string;
  }>({
    checking: false,
    updateAvailable: false,
  });
  const [installing, setInstalling] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const addToast = useStore((s) => s.addToast);

  const checkForUpdates = async () => {
    setUpdateStatus({ checking: true, updateAvailable: false });
    try {
      const result = await api.checkForUpdates();
      setUpdateStatus({
        checking: false,
        updateAvailable: result.updateAvailable,
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
      });
    } catch (error) {
      setUpdateStatus({
        checking: false,
        updateAvailable: false,
        error: error instanceof Error ? error.message : "Failed to check for updates",
      });
    }
  };

  const installUpdate = async () => {
    setInstalling(true);
    setConfirmInstall(false);
    try {
      await api.installUpdate();
      addToast("Update started! The server will restart automatically.", "success");
    } catch (error) {
      setInstalling(false);
      addToast(`Update failed: ${error instanceof Error ? error.message : "Unknown error"}`, "error");
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Settings</h2>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="space-y-6">
            {/* Appearance */}
            <section>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Appearance</h3>
              <div className="space-y-3">
                <label className="flex items-center justify-between">
                  <span className="text-gray-700 dark:text-gray-300">Dark Mode</span>
                  <input
                    type="checkbox"
                    checked={darkMode}
                    onChange={(e) => setDarkMode(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                  />
                </label>
              </div>
            </section>

            {/* Editor */}
            <section>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Editor</h3>
              <div className="space-y-3">
                <label className="flex items-center justify-between">
                  <span className="text-gray-700 dark:text-gray-300">Coder View (Syntax Highlighting)</span>
                  <input
                    type="checkbox"
                    checked={coderMode}
                    onChange={(e) => setCoderMode(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                  />
                </label>
              </div>
            </section>

            {/* Notifications */}
            <section>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Notifications</h3>
              <div className="space-y-3">
                <label className="flex items-center justify-between">
                  <span className="text-gray-700 dark:text-gray-300">Enable Notifications</span>
                  <input
                    type="checkbox"
                    checked={notificationsEnabled}
                    onChange={(e) => setNotificationsEnabled(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                  />
                </label>
                <div className="space-y-1">
                  <label className="block text-gray-700 dark:text-gray-300 text-sm">
                    App URL
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Base URL of this FossClaw instance. When set, webhook notifications include a link to the session.
                  </p>
                  <input
                    type="url"
                    value={appUrlInput}
                    onChange={(e) => setAppUrlInput(e.target.value)}
                    onBlur={() => setAppUrl(appUrlInput)}
                    placeholder="https://fossclaw.example.com"
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-gray-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-gray-700 dark:text-gray-300 text-sm">
                    Webhook URL
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    POST request sent when a session is waiting for input. Compatible with Slack and Discord incoming webhooks.
                  </p>
                  <input
                    type="url"
                    value={webhookInput}
                    onChange={(e) => { setWebhookInput(e.target.value); setTestStatus("idle"); }}
                    onBlur={() => setWebhookUrl(webhookInput)}
                    placeholder="https://hooks.slack.com/... or https://discord.com/api/webhooks/..."
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-gray-500"
                  />
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={async () => {
                        if (webhookInput !== webhookUrl) setWebhookUrl(webhookInput);
                        setTestStatus("sending");
                        setTestError("");
                        try {
                          await api.testNotification();
                          setTestStatus("ok");
                        } catch (err) {
                          setTestStatus("error");
                          setTestError(err instanceof Error ? err.message : "Failed");
                        }
                      }}
                      disabled={testStatus === "sending" || !webhookInput}
                      className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {testStatus === "sending" ? "Sending..." : "Test"}
                    </button>
                    {testStatus === "ok" && (
                      <span className="text-sm text-green-600 dark:text-green-400">Sent!</span>
                    )}
                    {testStatus === "error" && (
                      <span className="text-sm text-red-600 dark:text-red-400">{testError}</span>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* Session Naming */}
            <section>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Session Naming</h3>
              <div className="space-y-3">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Sessions are automatically named from your first message. Optionally connect an Ollama instance for improved names via LLM.
                </p>
                <div className="space-y-1">
                  <label className="block text-gray-700 dark:text-gray-300 text-sm">
                    Ollama URL
                  </label>
                  <input
                    type="url"
                    value={ollamaUrlInput}
                    onChange={(e) => { setOllamaUrlInput(e.target.value); setOllamaTestStatus("idle"); }}
                    onBlur={() => setOllamaUrl(ollamaUrlInput)}
                    placeholder="http://localhost:11434"
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-gray-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-gray-700 dark:text-gray-300 text-sm">
                    Ollama Model
                  </label>
                  <input
                    type="text"
                    value={ollamaModelInput}
                    onChange={(e) => { setOllamaModelInput(e.target.value); setOllamaTestStatus("idle"); }}
                    onBlur={() => setOllamaModel(ollamaModelInput)}
                    placeholder="llama3.2:3b"
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-gray-500"
                  />
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={async () => {
                      if (ollamaUrlInput !== ollamaUrl) setOllamaUrl(ollamaUrlInput);
                      if (ollamaModelInput !== ollamaModel) setOllamaModel(ollamaModelInput);
                      setOllamaTestStatus("sending");
                      setOllamaTestError("");
                      try {
                        const result = await api.testOllama(ollamaUrlInput, ollamaModelInput || undefined);
                        if (result.ok) {
                          setOllamaTestStatus("ok");
                        } else {
                          setOllamaTestStatus("error");
                          setOllamaTestError(result.error || "Connection failed");
                        }
                      } catch (err) {
                        setOllamaTestStatus("error");
                        setOllamaTestError(err instanceof Error ? err.message : "Failed");
                      }
                    }}
                    disabled={ollamaTestStatus === "sending" || !ollamaUrlInput}
                    className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {ollamaTestStatus === "sending" ? "Testing..." : "Test Connection"}
                  </button>
                  {ollamaTestStatus === "ok" && (
                    <span className="text-sm text-green-600 dark:text-green-400">Connected!</span>
                  )}
                  {ollamaTestStatus === "error" && (
                    <span className="text-sm text-red-600 dark:text-red-400">{ollamaTestError}</span>
                  )}
                </div>
              </div>
            </section>

            {/* Updates */}
            <section>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Updates</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-gray-700 dark:text-gray-300">Check for updates</p>
                    {updateStatus.currentVersion && (
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        Current version: {updateStatus.currentVersion}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={checkForUpdates}
                    disabled={updateStatus.checking}
                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {updateStatus.checking ? "Checking..." : "Check Now"}
                  </button>
                </div>

                {updateStatus.error && (
                  <div className="p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded">
                    {updateStatus.error}
                  </div>
                )}

                {updateStatus.updateAvailable && updateStatus.latestVersion && (
                  <div className="p-4 bg-blue-100 dark:bg-blue-900/30 rounded space-y-3">
                    <p className="text-blue-800 dark:text-blue-200 font-medium">
                      Update available: v{updateStatus.latestVersion}
                    </p>
                    {confirmInstall ? (
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-blue-800 dark:text-blue-200">The server will restart. Confirm?</span>
                        <button
                          onClick={installUpdate}
                          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                        >
                          Install
                        </button>
                        <button
                          onClick={() => setConfirmInstall(false)}
                          className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmInstall(true)}
                        disabled={installing}
                        className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {installing ? "Installing..." : "Install Update"}
                      </button>
                    )}
                    <p className="text-sm text-blue-700 dark:text-blue-300">
                      The server will restart automatically after installing the update.
                    </p>
                  </div>
                )}

                {!updateStatus.checking && !updateStatus.updateAvailable && updateStatus.currentVersion && !updateStatus.error && (
                  <div className="p-3 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded">
                    You're running the latest version!
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
