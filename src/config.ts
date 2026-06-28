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

// Auto-size the window to its content (config window is 460 wide).
const fit = () => {
  requestAnimationFrame(() => {
    const el = document.getElementById("app");
    if (!el) return;
    const h = Math.min(760, Math.max(220, Math.ceil(el.offsetHeight)));
    win.setSize(new LogicalSize(460, h)).catch(() => {});
  });
  setTimeout(() => {
    const el = document.getElementById("app");
    if (!el) return;
    const h = Math.min(760, Math.max(220, Math.ceil(el.offsetHeight)));
    win.setSize(new LogicalSize(460, h)).catch(() => {});
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
    const tip = escapeHtml(`${c.id}: ${c.detail}`);
    return `<span class="cfg-rel__dot cfg-rel__dot--${c.passed ? "ok" : "bad"}" title="${tip}"></span>`;
  }).join("");
  return (
    `<div class="cfg-fit__head">` +
      `<span class="cfg-fit__led cfg-fit__led--${relCls(r.verdict)}"></span>` +
      `<span class="cfg-fit__word">Tools: ${r.verdict}</span>` +
      `<span class="cfg-fit__detail">${r.passed}/${r.total} cases</span>` +
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

  const section = (label?: string): HTMLDivElement => {
    const s = document.createElement("div");
    s.className = "cfg-sec";
    if (label) {
      const l = document.createElement("div");
      l.className = "cfg-sec__label";
      l.textContent = label;
      s.appendChild(l);
    }
    body.appendChild(s);
    return s;
  };

  // Header
  const header = document.createElement("div");
  header.className = "cfg-head";
  header.innerHTML = `<span class="cfg-head__name">${escapeHtml(name)}</span>`;
  body.appendChild(header);

  // Fit
  const fitEl = document.createElement("div");
  fitEl.className = "cfg-fit";
  body.appendChild(fitEl);
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
  const qSec = section("Quality");
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
  const mem = (ctx: number) => (info.kv_per_token > 0 ? gb(info.file_bytes + ctx * info.kv_per_token) : "n/a");
  const cSec = section(info.native_ctx ? `Context length · up to ${tierLabel(info.native_ctx)}` : "Context length");
  const pills = document.createElement("div");
  pills.className = "cfg-pills";
  const mk = (text: string, val: number | null, sub: string) => {
    const b = document.createElement("button");
    b.className = "cfg-pill" + ((ov.ctx_size ?? null) === val ? " cfg-pill--on" : "");
    b.innerHTML = `${text}<span class="cfg-pill__sub">${sub}</span>`;
    b.onclick = () => {
      ov.ctx_size = val;
      pills.querySelectorAll(".cfg-pill").forEach((el) => el.classList.remove("cfg-pill--on"));
      b.classList.add("cfg-pill--on");
      renderFit(val);
    };
    return b;
  };
  pills.appendChild(mk("Auto", null, "fit"));
  for (const t of CTX_TIERS.filter((t) => t <= max)) pills.appendChild(mk(tierLabel(t), t, mem(t)));
  cSec.appendChild(pills);

  // Advanced
  const adv = document.createElement("details");
  adv.className = "cfg-adv";
  adv.innerHTML = `<summary class="cfg-adv__summary">Advanced</summary>`;
  adv.addEventListener("toggle", fit);
  const advFields: [keyof ModelOverride, string][] = [
    ["temp", "Temperature"], ["top_p", "Top-p"], ["top_k", "Top-k"], ["min_p", "Min-p"],
    ["repeat_penalty", "Repeat"], ["presence_penalty", "Presence"], ["frequency_penalty", "Frequency"],
  ];
  const grid = document.createElement("div");
  grid.className = "cfg-grid";
  for (const [k, lbl] of advFields) {
    const f = document.createElement("label");
    f.className = "cfg-field";
    f.innerHTML = `<span>${lbl}</span><input type="number" step="0.05" value="${ov[k] ?? ""}" placeholder="auto" />`;
    const inp = f.querySelector("input") as HTMLInputElement;
    inp.oninput = () => { (ov[k] as number | null) = inp.value === "" ? null : Number(inp.value); };
    grid.appendChild(f);
  }
  adv.appendChild(grid);

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
  rel.appendChild(relBtn);
  adv.appendChild(rel);
  body.appendChild(adv);

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
  reset.onclick = async () => {
    try { await invoke("set_model_config", { modelId: id, override: {} }); } catch (err) { alert(String(err)); return; }
    await emit("config-changed");
    await close();
  };
  const save = document.createElement("button");
  save.className = "btn btn--primary";
  save.textContent = "Save and load";
  save.onclick = async () => {
    try { await invoke("set_model_config", { modelId: id, override: ov }); } catch (err) { alert(String(err)); return; }
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
