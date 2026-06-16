// Thin wrappers around the Tauri v2 updater + process plugins, so the rest of
// the app never imports the plugins directly and everything is guarded for the
// browser (dev) where there is no Tauri runtime. Plugins are dynamically
// imported so they stay out of the browser bundle path.
import type { Update } from "@tauri-apps/plugin-updater";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type DownloadProgress = { downloaded: number; total: number; percent: number };

/// Ask the configured endpoints whether a newer signed release exists.
/// Returns the Update handle (call `installUpdate`) or null when up to date.
export async function checkForUpdate(): Promise<Update | null> {
  if (!isTauri()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  return await check();
}

/// Download + install the update (signature is verified by the plugin against
/// the configured pubkey), reporting progress, then relaunch into the new build.
export async function installUpdate(
  update: Update,
  onProgress: (progress: DownloadProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        onProgress({ downloaded: 0, total, percent: 0 });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress({
          downloaded,
          total,
          percent: total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0,
        });
        break;
      case "Finished":
        onProgress({ downloaded: total, total, percent: 100 });
        break;
    }
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
