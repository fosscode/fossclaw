import { useState, FormEvent } from "react";
import { api } from "../api.js";

interface LoginProps {
  onSuccess: () => void;
}

export function Login({ onSuccess }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await api.login(username, password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-[100dvh] flex items-center justify-center bg-cc-bg">
      <div className="w-full max-w-md p-8 space-y-6">
        <div className="flex flex-col items-center space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cc-primary to-purple-600 flex items-center justify-center shadow-xl">
            <svg viewBox="0 0 32 32" fill="none" className="w-9 h-9 text-white">
              <path d="M16 4C16 4 12 8 12 12C12 14.2091 13.7909 16 16 16C18.2091 16 20 14.2091 20 12C20 8 16 4 16 4Z" fill="currentColor"/>
              <path d="M8 10C8 10 4 14 4 18C4 20.2091 5.79086 22 8 22C10.2091 22 12 20.2091 12 18C12 14 8 10 8 10Z" fill="currentColor" opacity="0.8"/>
              <path d="M24 10C24 10 20 14 20 18C20 20.2091 21.7909 22 24 22C26.2091 22 28 20.2091 28 18C28 14 24 10 24 10Z" fill="currentColor" opacity="0.8"/>
              <path d="M16 18C16 18 12 22 12 26C12 28.2091 13.7909 30 16 30C18.2091 30 20 28.2091 20 26C20 22 16 18 16 18Z" fill="currentColor" opacity="0.6"/>
            </svg>
          </div>
          <p className="text-cc-fg/60 text-sm">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="username" className="block text-sm font-medium text-cc-fg">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              autoFocus
              className="w-full px-3 py-2 bg-cc-surface border border-cc-border rounded-lg
                       text-cc-fg placeholder:text-cc-fg/40
                       focus:outline-none focus:ring-2 focus:ring-cc-primary/50"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="block text-sm font-medium text-cc-fg">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full px-3 py-2 bg-cc-surface border border-cc-border rounded-lg
                       text-cc-fg placeholder:text-cc-fg/40
                       focus:outline-none focus:ring-2 focus:ring-cc-primary/50"
            />
          </div>

          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p className="text-sm text-red-500">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-2 bg-cc-primary hover:bg-cc-primary-hover
                     text-white font-medium rounded-lg
                     transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
