import { useState } from "react";
import { useStore } from "../store";
import { api } from "../api";

export function Settings({ onClose }: { onClose: () => void }) {
  const darkMode = useStore((s) => s.darkMode);
  const setDarkMode = useStore((s) => s.setDarkMode);
  const coderMode = useStore((s) => s.coderMode);
  const setCoderMode = useStore((s) => s.setCoderMode);
  const notificationsEnabled = useStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useStore((s) => s.setNotificationsEnabled);

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
    if (!confirm("Install update? The server will restart.")) {
      return;
    }

    setInstalling(true);
    try {
      await api.installUpdate();
      // Server will restart, show message
      alert("Update started! The server will restart automatically.");
    } catch (error) {
      setInstalling(false);
      alert(`Update failed: ${error instanceof Error ? error.message : "Unknown error"}`);
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
                    <button
                      onClick={installUpdate}
                      disabled={installing}
                      className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {installing ? "Installing..." : "Install Update"}
                    </button>
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
