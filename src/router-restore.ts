// Restart-safe model restore. Per-model config (and several settings) are baked
// into the router's startup preset, so applying them restarts the router — which
// drops every loaded model. These helpers snapshot what was loaded and bring it
// back once the new router is healthy, so a config change never silently unloads
// what was running.

import { invoke } from "@tauri-apps/api/core";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const LOADED = (s: string) => s === "loaded" || s === "sleeping";

/** Ids currently resident in the router. */
export async function loadedModelIds(): Promise<string[]> {
  try {
    const ms = await invoke<{ id: string; status: string }[]>("list_models");
    return ms.filter((m) => LOADED(m.status)).map((m) => m.id);
  } catch {
    return [];
  }
}

/** Retry load_model until the (restarting) router accepts it, or we give up. */
export async function loadWithRetry(modelId: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await invoke("load_model", { modelId });
      return;
    } catch (e) {
      if (Date.now() - start > timeoutMs) throw e;
      await sleep(300);
    }
  }
}

/** After a router-restarting action, bring the given models back online,
    retrying until the new router accepts each. A failure on one doesn't stop
    the rest. */
export async function restoreLoaded(ids: string[]): Promise<void> {
  await sleep(500); // let the old router shut down before poking the new one
  for (const m of ids) {
    try {
      await loadWithRetry(m);
    } catch {
      /* restore the rest */
    }
  }
}
