// Typed wrappers around Tauri APIs. Components never call invoke()/window APIs
// directly (docs/coding-conventions.md). Every wrapper is a no-op outside the Tauri
// WebView, so the frontend also runs under `npm run dev` in a normal browser.
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Sets the native window title (requires `core:window:allow-set-title`). */
export async function setWindowTitle(title: string): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().setTitle(title);
}
