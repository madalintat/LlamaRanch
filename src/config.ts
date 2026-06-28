// Model configuration window. Opened from the popover (gear / model click) via
// an "open-config" event carrying the model id + name. Renders fit, quality,
// context, and advanced sampling; Save/Reset/Delete write back and emit
// "config-changed" so the popover refreshes, then the window hides.

import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { applyTheme, type Theme } from "./brand/theme";
import "./styles.css";
import { escapeHtml } from "./paths.ts";
import { loadedModelIds, restoreLoaded } from "./router-restore";

const win = getCurrentWindow();
const body = document.getElementById("cfg-body") as HTMLDivElement;

// ── Types (shared shape with the backend) ──────────────────────────────────
type ModelOverride = {
  ctx_size?: number | null; temp?: number | null; top_p?: number | null; top_k?: number | null;
  min_p?: number | null; repeat_penalty?: number | null; presence_penalty?: number | null; frequency_penalty?: number | null;
};
type ModelInfo = { native_ctx: number; file_bytes: number; kv_per_token: number; override: ModelOverride };
type ModelFit = {
  verdict: string; eval_ctx: number; needed_bytes: number;
  fast_budget: number; usable_ceiling: number; total_ram: number;
  gpu_label: string; fast_ctx: number; usable_ctx: number;
  needs_smaller_quant: boolean; native_ctx: number;
};
type RelCase = { id: string; passed: boolean; detail: string };
type RelReport = { model: string; passed: number; total: number; score: number; verdict: string; cases: RelCase[] };
type Quant = { label: string; bpw: number };
type QuantMetrics = { kld: number; top1_agreement: number; ppl_ratio: number };
type QuantEntry = { quant: Quant; model_id: string; metrics: QuantMetrics; sharpness: number; band: string; is_reference: boolean };
type QuantReport = { base: string; reference: string; entries: QuantEntry[]; sweet_spot: string | null; measured_unix: number; calibration_version: number };

const gb = (n: number) => (n / 1e9).toFixed(1) + " GB";
const CTX_TIERS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
const tierLabel = (n: number) => (n % 1024 === 0 ? `${n / 1024}k` : String(n));
/** Persist a model's config — which restarts the router to bake in its preset —
    then bring the model (and anything else that was loaded) back online so a
    config change never silently unloads what was running. */
async function applyConfig(id: string, override: ModelOverride, forceLoadId: boolean): Promise<void> {
  const wanted = await loadedModelIds();
  if (forceLoadId && !wanted.includes(id)) wanted.push(id);
  await invoke("set_model_config", { modelId: id, override });
  await restoreLoaded(wanted);
}

// Auto-size the window to its content (config window is 420 wide).
const fit = () => {
  requestAnimationFrame(() => {
    const el = document.getElementById("app");
    if (!el) return;
    const h = Math.min(760, Math.max(220, Math.ceil(el.offsetHeight)));
    win.setSize(new LogicalSize(420, h)).catch(() => {});
  });
  setTimeout(() => {
    const el = document.getElementById("app");
    if (!el) return;
    const h = Math.min(760, Math.max(220, Math.ceil(el.offsetHeight)));
    win.setSize(new LogicalSize(420, h)).catch(() => {});
  }, 90);
};

function fitVerdict(f: ModelFit): { word: string; cls: string; detail: string; advice: string } {
  const have = f.gpu_label === "CPU" ? f.total_ram : f.fast_budget;
  const detail = `needs ~${gb(f.needed_bytes)} · ${f.gpu_label} ~${gb(have)}`;
  switch (f.verdict) {
    case "fast":
      return { word: "Fits fast", cls: "ok", detail, advice: `full ${tierLabel(f.native_ctx)} context runs fast` };
    case "tight":
      return { word: "Tight fit", cls: "warn", detail,
        advice: f.fast_ctx > 0 ? `drop to ${tierLabel(f.fast_ctx)} to run fast` : `fits up to ${tierLabel(f.usable_ctx)}, but close to the limit` };
    case "slow":
      return { word: "Runs slow", cls: "warn", detail,
        advice: f.fast_ctx > 0 ? `drop to ${tierLabel(f.fast_ctx)} to run fast` : `no GPU here, runs on CPU at this size` };
    default:
      return { word: "Won't fit", cls: "error", detail,
        advice: f.needs_smaller_quant ? `too big for this machine, try a smaller quant` : `too big at this context, try ${tierLabel(f.usable_ctx)} or less` };
  }
}

function relCls(verdict: string): string {
  return verdict === "dependable" ? "ok" : verdict === "flaky" ? "warn" : "error";
}
function renderRel(r: RelReport): string {
  const dots = r.cases.map((c) => {
    const tip = escapeHtml(`${c.id}: ${c.passed ? "passed" : "failed"} · ${c.detail}`);
    return `<span class="cfg-rel__dot cfg-rel__dot--${c.passed ? "ok" : "bad"}" title="${tip}"></span>`;
  }).join("");
  const word = r.verdict === "dependable" ? "Reliable with tools" : r.verdict === "flaky" ? "Sometimes works" : "Struggles with tools";
  return (
    `<div class="cfg-fit__head">` +
      `<span class="cfg-fit__led cfg-fit__led--${relCls(r.verdict)}"></span>` +
      `<span class="cfg-fit__word">${word}</span>` +
      `<span class="cfg-fit__detail">${r.passed} of ${r.total} tool calls correct</span>` +
    `</div>` +
    `<div class="cfg-rel__dots">${dots}</div>`
  );
}

function bandCls(band: string): string {
  return band === "rough" ? "error" : band === "soft" ? "warn" : "ok";
}
function renderQuality(r: QuantReport): string {
  if (!r.entries.length) return `<div class="cfg-note">No sizes to measure.</div>`;
  if (r.entries.length === 1) {
    return `<div class="cfg-note">Only ${escapeHtml(r.entries[0].quant.label)} installed. Add a higher size to measure what you'd lose.</div>`;
  }
  const rows = r.entries.map((e) => {
    const note = e.is_reference ? "reference" : escapeHtml(e.band);
    const sweet = r.sweet_spot && e.quant.label === r.sweet_spot ? `<span class="cfg-qual__star">sweet spot</span>` : "";
    return (
      `<div class="cfg-qual__row">` +
        `<span class="cfg-fit__led cfg-fit__led--${bandCls(e.band)}"></span>` +
        `<span class="cfg-qual__label">${escapeHtml(e.quant.label)}</span>` +
        `<span class="cfg-qual__pct">${e.is_reference ? "ref" : e.sharpness + "%"}</span>` +
        `<span class="cfg-qual__note">${note}</span>` +
        sweet +
      `</div>`
    );
  }).join("");
  return `<div class="cfg-qual__ref">vs ${escapeHtml(r.reference)}, the heaviest you have</div><div class="cfg-qual__rows">${rows}</div>`;
}

/** A design slider: label + live value on top, a filled range track below. */
function mkSlider(
  label: string, min: number, max: number, step: number, init: number,
  fmt: (v: number) => string, onInput: (v: number) => void,
): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "cfg-slider";
  const head = document.createElement("div");
  head.className = "cfg-slider__head";
  const lab = document.createElement("span"); lab.className = "cfg-slider__label"; lab.textContent = label;
  const val = document.createElement("span"); val.className = "cfg-slider__val";
  head.append(lab, val);
  const input = document.createElement("input");
  input.type = "range"; input.className = "cfg-range";
  input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(init);
  const paint = () => {
    const v = Number(input.value);
    const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--pct", pct + "%");
    val.textContent = fmt(v);
  };
  input.oninput = () => { onInput(Number(input.value)); paint(); };
  paint();
  wrap.append(head, input);
  return wrap;
}

let currentId = "";

async function close() { await win.hide(); }

async function render(id: string, displayName: string, isLocal: boolean) {
  currentId = id;
  const eyebrow = document.querySelector(".cfg-win__eyebrow");
  if (eyebrow) eyebrow.textContent = "Configure";
  body.innerHTML = `<div class="cfg-note">Loading…</div>`;

  let info: ModelInfo;
  try {
    info = await invoke<ModelInfo>("model_info", { modelId: id });
  } catch (e) {
    body.innerHTML = `<div class="cfg-note">Couldn't load model info: ${escapeHtml(String(e))}</div>`;
    fit();
    return;
  }
  if (currentId !== id) return; // a newer open superseded us
  const ov: ModelOverride = { ...info.override };
  const name = displayName || id;
  body.innerHTML = "";

  const section = (label: string | undefined, host: HTMLElement): HTMLDivElement => {
    const s = document.createElement("div");
    s.className = "cfg-sec";
    if (label) {
      const l = document.createElement("div");
      l.className = "cfg-sec__label";
      l.textContent = label;
      s.appendChild(l);
    }
    host.appendChild(s);
    return s;
  };

  // Header (model name)
  const header = document.createElement("div");
  header.className = "cfg-head";
  header.innerHTML = `<span class="cfg-head__name">${escapeHtml(name)}</span>`;
  body.appendChild(header);

  // Two tabs so nothing scrolls: Model (fit/quality/context) and Sampling.
  const tabbar = document.createElement("div");
  tabbar.className = "cfg-tabs";
  const tModel = document.createElement("div");
  tModel.className = "cfg-tab";
  const tSampling = document.createElement("div");
  tSampling.className = "cfg-tab cfg-tab--hidden";
  const mkTab = (label: string, panel: HTMLElement, active: boolean) => {
    const b = document.createElement("button");
    b.className = "cfg-tab-btn" + (active ? " cfg-tab-btn--on" : "");
    b.textContent = label;
    b.onclick = () => {
      tabbar.querySelectorAll(".cfg-tab-btn").forEach((el) => el.classList.remove("cfg-tab-btn--on"));
      b.classList.add("cfg-tab-btn--on");
      tModel.classList.toggle("cfg-tab--hidden", panel !== tModel);
      tSampling.classList.toggle("cfg-tab--hidden", panel !== tSampling);
      fit();
    };
    return b;
  };
  tabbar.append(mkTab("Model", tModel, true), mkTab("Sampling", tSampling, false));
  body.append(tabbar, tModel, tSampling);

  // Fit (Model tab)
  const fitEl = document.createElement("div");
  fitEl.className = "cfg-fit";
  tModel.appendChild(fitEl);
  const renderFit = async (ctx: number | null) => {
    let f: ModelFit;
    try { f = await invoke<ModelFit>("fit_estimate", { modelId: id, ctxSize: ctx }); } catch { fitEl.innerHTML = ""; return; }
    if (currentId !== id) return;
    const v = fitVerdict(f);
    fitEl.innerHTML =
      `<div class="cfg-fit__head"><span class="cfg-fit__led cfg-fit__led--${v.cls}"></span><span class="cfg-fit__word">${v.word}</span><span class="cfg-fit__detail">${escapeHtml(v.detail)}</span></div>` +
      `<div class="cfg-fit__advice">${escapeHtml(v.advice)}</div>`;
    fit();
  };
  renderFit(ov.ctx_size ?? null);

  // Quality
  const qSec = section("Quality", tModel);
  const qual = document.createElement("div");
  qual.className = "cfg-qual";
  qSec.appendChild(qual);
  const qualBtn = document.createElement("button");
  qualBtn.className = "btn cfg-action";
  qualBtn.textContent = "Measure quality";
  qSec.appendChild(qualBtn);
  const showQual = (r: QuantReport) => { if (currentId !== id) return; qual.innerHTML = renderQuality(r); qualBtn.textContent = "Re-measure"; fit(); };
  qualBtn.onclick = async () => {
    qualBtn.disabled = true;
    const prev = qualBtn.textContent;
    qualBtn.textContent = "Measuring…";
    try { showQual(await invoke<QuantReport>("measure_quality", { modelId: id })); }
    catch (e) { if (currentId === id) qual.innerHTML = `<div class="cfg-note">Couldn't measure: ${escapeHtml(String(e))}</div>`; }
    finally { qualBtn.disabled = false; if (qualBtn.textContent === "Measuring…") qualBtn.textContent = prev || "Measure quality"; }
    fit();
  };
  invoke<QuantReport | null>("quality_report", { modelId: id }).then((r) => { if (r) showQual(r); }).catch(() => {});

  // Context
  const max = info.native_ctx || 262144;
  const mem = (ctx: number) => (info.kv_per_token > 0 ? gb(info.file_bytes + ctx * info.kv_per_token) : "");
  const tiers = CTX_TIERS.filter((t) => t <= max);
  const ctxStops: (number | null)[] = [null, ...tiers]; // index 0 = Auto (fit to memory)
  let ctxIdx = ctxStops.findIndex((s) => s === (ov.ctx_size ?? null));
  if (ctxIdx < 0) ctxIdx = 0;
  const cSec = section(info.native_ctx ? `Context window · up to ${tierLabel(info.native_ctx)}` : "Context window", tModel);
  cSec.appendChild(mkSlider(
    "Length", 0, ctxStops.length - 1, 1, ctxIdx,
    (i) => { const s = ctxStops[Math.round(i)]; return s == null ? "Auto" : tierLabel(s) + (mem(s) ? ` · ${mem(s)}` : ""); },
    (i) => { const s = ctxStops[Math.round(i)]; ov.ctx_size = s; renderFit(s); },
  ));

  // ── Sampling: sliders (Reset clears all back to the model's own defaults) ──
  const sSec = section("Sampling", tSampling);
  type SDef = { k: keyof ModelOverride; label: string; min: number; max: number; step: number; def: number };
  const sdefs: SDef[] = [
    { k: "temp", label: "Temperature", min: 0, max: 2, step: 0.05, def: 0.7 },
    { k: "top_p", label: "Top-p", min: 0, max: 1, step: 0.01, def: 0.9 },
    { k: "top_k", label: "Top-k", min: 0, max: 100, step: 1, def: 40 },
    { k: "min_p", label: "Min-p", min: 0, max: 0.5, step: 0.01, def: 0.05 },
    { k: "repeat_penalty", label: "Repeat penalty", min: 1, max: 1.5, step: 0.01, def: 1.1 },
  ];
  for (const d of sdefs) {
    const isInt = d.step >= 1;
    const init = (ov[d.k] as number | null) ?? d.def;
    sSec.appendChild(mkSlider(
      d.label, d.min, d.max, d.step, init,
      () => ((ov[d.k] as number | null) == null ? "auto" : (isInt ? String(Math.round(ov[d.k] as number)) : (ov[d.k] as number).toFixed(2))),
      (v) => { (ov[d.k] as number | null) = isInt ? Math.round(v) : Number(v.toFixed(2)); },
    ));
  }

  // ── Reliability: a one-shot tool-call check ──
  const relSec = section("Reliability", tSampling);
  const relNote = document.createElement("div");
  relNote.className = "cfg-note";
  relNote.textContent =
    "The agent reaches for tools (web search, reading files) by emitting a structured call. This runs four tiny tests to see whether this model produces valid calls, so you know before you trust it in the agent.";
  relSec.appendChild(relNote);
  const rel = document.createElement("div");
  rel.className = "cfg-rel";
  const relBtn = document.createElement("button");
  relBtn.className = "btn cfg-action";
  relBtn.textContent = "Test tool calls";
  relBtn.onclick = async () => {
    relBtn.disabled = true;
    relBtn.textContent = "Testing…";
    try { const r = await invoke<RelReport>("eval_tool_reliability", { modelId: id }); if (currentId === id) rel.innerHTML = renderRel(r); }
    catch (e) { rel.innerHTML = `<div class="cfg-note">Test failed: ${escapeHtml(String(e))}</div>`; }
    finally { relBtn.disabled = false; if (relBtn.textContent === "Testing…") relBtn.textContent = "Test tool calls"; }
    fit();
  };
  relSec.append(relBtn, rel);

  // Actions
  const actions = document.createElement("div");
  actions.className = "cfg-actions";
  const delBtn = document.createElement("button");
  delBtn.className = "btn btn--ghost cfg-actions__del";
  delBtn.textContent = "Delete";
  delBtn.onclick = async () => {
    const msg = isLocal ? `Delete ${name} from disk?` : `Delete ${name}? This removes it from the shared cache (also used by the Llama app).`;
    if (!confirm(msg)) return;
    try { await invoke("delete_model", { modelId: id }); } catch (err) { alert(String(err)); return; }
    await emit("config-changed");
    await close();
  };
  const right = document.createElement("div");
  right.className = "cfg-actions__right";
  const reset = document.createElement("button");
  reset.className = "btn";
  reset.textContent = "Reset";
  const save = document.createElement("button");
  save.className = "btn btn--primary";
  save.textContent = "Save and load";
  const setBusy = (b: boolean) => { save.disabled = reset.disabled = delBtn.disabled = b; };

  reset.onclick = async () => {
    setBusy(true); reset.textContent = "Resetting…";
    try { await applyConfig(id, {}, false); }
    catch (err) { alert(String(err)); setBusy(false); reset.textContent = "Reset"; return; }
    await emit("config-changed");
    await close();
  };
  save.onclick = async () => {
    setBusy(true); save.textContent = "Saving & loading…";
    try { await applyConfig(id, ov, true); }
    catch (err) { alert(String(err)); setBusy(false); save.textContent = "Save and load"; return; }
    await emit("config-changed");
    await close();
  };
  right.append(reset, save);
  actions.append(delBtn, right);
  body.appendChild(actions);

  fit();
}

// ── Wiring ──
document.getElementById("cfg-close")?.addEventListener("click", () => void close());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") void close(); });

// Event subscriptions (wrapped: the build target has no top-level await).
void (async () => {
  // The popover asks us to configure a specific model.
  await listen<{ modelId: string; name: string; local: boolean }>("open-config", (e) => {
    void render(e.payload.modelId, e.payload.name, e.payload.local);
  });
  // Live theme updates from the Settings window.
  await listen<Theme>("theme-changed", (e) => applyTheme(e.payload));
})();
