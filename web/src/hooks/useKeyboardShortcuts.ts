import { useEffect } from "react";

export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  description: string;
  handler: (e: KeyboardEvent) => void;
  /** If true, shortcut works even when input is focused */
  global?: boolean;
}

/**
 * Hook to register keyboard shortcuts
 *
 * @param shortcuts Array of keyboard shortcuts to register
 * @param enabled Whether shortcuts are enabled (default: true)
 */
export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcut[],
  enabled = true
) {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      for (const shortcut of shortcuts) {
        // Check if we should skip this shortcut
        if (isInput && !shortcut.global) continue;

        // Match the key combination
        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();
        const ctrlMatch = shortcut.ctrl ? e.ctrlKey || e.metaKey : !e.ctrlKey && !e.metaKey;
        const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey;
        const altMatch = shortcut.alt ? e.altKey : !e.altKey;

        if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
          e.preventDefault();
          shortcut.handler(e);
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts, enabled]);
}

/**
 * Hook for Vimium-style navigation hints
 * Adds data-vimium-hint attribute to focusable elements
 */
export function useVimiumHints(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const selectors = [
      'button:not([disabled])',
      'a[href]',
      '[role="button"]',
      '[tabindex="0"]',
    ];

    const elements = document.querySelectorAll(selectors.join(','));
    elements.forEach((el, i) => {
      el.setAttribute('data-vimium-hint', String(i + 1));
    });

    return () => {
      elements.forEach((el) => {
        el.removeAttribute('data-vimium-hint');
      });
    };
  }, [enabled]);
}
