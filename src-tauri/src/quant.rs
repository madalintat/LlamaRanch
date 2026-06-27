//! Model quality: measure, on this machine, how much quality a quantized model
//! actually lost against a near-lossless reference, and name the sweet spot.
//!
//! A local model is a shrunk model. Almost nothing tells you how much it lost,
//! so people run on forum lore. Here we measure it. The metric math and the
//! grading are pure and unit-tested; only the calibration pass touches the
//! router. The honest part: KL-divergence cleanly separates aggressive quants
//! but goes blind near the reference, so we carry a confidence and say so when
//! two sizes are genuinely too close to call.
use crate::commands::AppConfig;
use crate::scanner;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;
use tauri::State;

/// Bump when the calibration corpora or metric definitions change, so stale
/// cached reports are recomputed rather than trusted.
pub const CALIBRATION_VERSION: u32 = 1;

// ── Quant identity ──────────────────────────────────────────────────────────

/// A quantization level parsed from a GGUF filename. `bpw` (approximate bits per
/// weight) is used only to rank sizes: higher is more faithful, and the highest
/// present locally becomes the reference everything else is measured against.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Quant {
    pub label: String,
    pub bpw: f32,
}

/// Known quant tokens and their approximate bits-per-weight. Longest tokens
/// first so `Q4_K_M` is matched before `Q4_K` or `Q4`. The numbers are coarse
/// (sizing only); they never enter a quality score.
const QUANT_TABLE: &[(&str, f32)] = &[
    ("F32", 32.0),
    ("BF16", 16.0),
    ("F16", 16.0),
    ("Q8_0", 8.5),
    ("Q6_K", 6.56),
    ("Q5_K_M", 5.69),
    ("Q5_K_S", 5.52),
    ("Q5_1", 6.0),
    ("Q5_0", 5.54),
    ("Q4_K_M", 4.85),
    ("Q4_K_S", 4.58),
    ("Q4_1", 4.91),
    ("Q4_0", 4.55),
    ("Q3_K_L", 4.27),
    ("Q3_K_M", 3.91),
    ("Q3_K_S", 3.5),
    ("Q2_K", 3.35),
    ("IQ4_NL", 4.5),
    ("IQ4_XS", 4.25),
    ("IQ3_M", 3.66),
    ("IQ3_S", 3.44),
    ("IQ3_XXS", 3.06),
    ("IQ2_M", 2.7),
    ("IQ2_S", 2.5),
    ("IQ2_XXS", 2.06),
    ("IQ1_M", 1.75),
    ("IQ1_S", 1.56),
];

/// Parse a quant level out of a model id or filename. Case-insensitive, matches
/// the most specific token present (so `...Q4_K_M.gguf` is `Q4_K_M`, not `Q4`).
pub fn parse_quant(name: &str) -> Option<Quant> {
    let up = name.to_ascii_uppercase();
    QUANT_TABLE
        .iter()
        .find(|(tok, _)| up.contains(tok))
        .map(|(tok, bpw)| Quant { label: (*tok).to_string(), bpw: *bpw })
}

/// The base model name: the id with its quant token and `.gguf` stripped, so the
/// different sizes of one model collapse to a single herd member. Falls back to
/// the trimmed id when no quant token is present.
pub fn base_name(name: &str) -> String {
    let mut s = name.trim().to_string();
    if let Some(stripped) = s.strip_suffix(".gguf").or_else(|| s.strip_suffix(".GGUF")) {
        s = stripped.to_string();
    }
    if let Some(q) = parse_quant(&s) {
        // Remove the quant token (and a trailing/leading separator) wherever it sits.
        let up = s.to_ascii_uppercase();
        if let Some(pos) = up.find(&q.label) {
            let mut out = String::new();
            out.push_str(&s[..pos]);
            out.push_str(&s[pos + q.label.len()..]);
            s = out;
        }
    }
    s.trim_matches(|c: char| c == '-' || c == '_' || c == '.' || c == ' ').to_string()
}

// ── Raw measured metrics ────────────────────────────────────────────────────

/// What one calibration pass yields for a candidate quant against the reference,
/// per domain. All three signals point the same way: lower divergence and higher
/// agreement mean the candidate behaves more like the reference.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuantMetrics {
    /// Mean KL-divergence of the candidate from the reference, in nats. ~0 means
    /// indistinguishable; large means the distributions parted ways.
    pub kld: f64,
    /// Fraction of positions where the candidate's top token matched the
    /// reference's top token. 1.0 is perfect agreement.
    pub top1_agreement: f64,
    /// Candidate perplexity divided by reference perplexity. >= ~1.0; higher
    /// means the candidate is more surprised by the same text.
    pub ppl_ratio: f64,
}

/// Below this mean KLD (nats) a candidate is statistically too close to the
/// reference to call apart. This is the honesty threshold: we refuse to invent a
/// difference the measurement cannot actually see.
pub const KLD_INDISTINGUISHABLE: f64 = 0.012;

// ── Pure metric math (unit-tested without a model) ──────────────────────────

/// Per-position scoring of a calibration text by one model: for each predicted
/// position, the token the model actually scored, the log-probability it gave
/// that token, and its top-k `(token, probability)` distribution.
#[derive(Clone, Debug, PartialEq)]
pub struct PositionScore {
    pub top1: String,
    pub logprob_actual: f64,
    pub dist: Vec<(String, f64)>,
}

/// Perplexity from per-token log-probabilities (natural log): `exp(-mean)`.
/// Empty input is a perplexity of 1.0 (no surprise to account for).
pub fn perplexity(logprobs: &[f64]) -> f64 {
    if logprobs.is_empty() {
        return 1.0;
    }
    let mean = logprobs.iter().sum::<f64>() / logprobs.len() as f64;
    (-mean).exp()
}

/// Fraction of positions where the candidate's top token equals the reference's.
/// Compares up to the shorter length; returns 1.0 when there is nothing to
/// compare (no evidence of disagreement).
pub fn top1_agreement(candidate: &[PositionScore], reference: &[PositionScore]) -> f64 {
    let n = candidate.len().min(reference.len());
    if n == 0 {
        return 1.0;
    }
    let matches = (0..n).filter(|&i| candidate[i].top1 == reference[i].top1).count();
    matches as f64 / n as f64
}

/// Mean KL-divergence D(reference || candidate) over the reference's top-k
/// support, in nats. The reference distribution is the "truth" we measure drift
/// from; candidate mass missing under a reference token is floored to `EPS` so a
/// dropped token registers as large (not infinite) divergence. Renormalizes each
/// position's reference support so the comparison is a proper distribution.
pub fn mean_kld(candidate: &[PositionScore], reference: &[PositionScore]) -> f64 {
    const EPS: f64 = 1e-6;
    let n = candidate.len().min(reference.len());
    if n == 0 {
        return 0.0;
    }
    let mut acc = 0.0;
    for i in 0..n {
        let cand: BTreeMap<&str, f64> =
            candidate[i].dist.iter().map(|(t, p)| (t.as_str(), *p)).collect();
        // Renormalize the reference's top-k into a distribution over its support.
        let ref_mass: f64 = reference[i].dist.iter().map(|(_, p)| *p).sum();
        if ref_mass <= 0.0 {
            continue;
        }
        let mut kld = 0.0;
        for (tok, p_raw) in &reference[i].dist {
            let p = p_raw / ref_mass;
            if p <= 0.0 {
                continue;
            }
            let q = cand.get(tok.as_str()).copied().unwrap_or(0.0).max(EPS);
            kld += p * (p / q).ln();
        }
        acc += kld.max(0.0);
    }
    acc / n as f64
}

// ── Grading (pure, unit-tested) ─────────────────────────────────────────────

/// How a quant lands, as a plain word.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Band {
    /// Effectively the reference: too close to call apart.
    Reference,
    /// Crisp: keeps almost all of the sharpness.
    Crisp,
    /// Solid: a small, safe loss.
    Solid,
    /// Soft: a real loss you can feel.
    Soft,
    /// Rough: noticeably dulled.
    Rough,
}

/// A 0..=100 "sharpness" score from the measured metrics. A heuristic blend of
/// top-token agreement (interpretable: how often it picks the reference's next
/// token) and perplexity inflation (how much more surprised it is). Pure.
pub fn sharpness_pct(m: &QuantMetrics) -> u32 {
    let ppl_term = (2.0 - m.ppl_ratio).clamp(0.0, 1.0); // 1.0 at parity, 0 at 2x ppl
    let blended = 0.75 * m.top1_agreement + 0.25 * ppl_term;
    (blended.clamp(0.0, 1.0) * 100.0).round() as u32
}

/// Band a quant from its sharpness and whether it is distinguishable from the
/// reference at all. When the divergence is below the noise floor we call it the
/// reference's equal rather than inventing a gap.
pub fn band_for(sharpness: u32, kld: f64) -> Band {
    if kld < KLD_INDISTINGUISHABLE {
        return Band::Reference;
    }
    match sharpness {
        97..=100 => Band::Crisp,
        93..=96 => Band::Solid,
        85..=92 => Band::Soft,
        _ => Band::Rough,
    }
}

// ── Report ──────────────────────────────────────────────────────────────────

/// One graded quant in a model's report.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuantEntry {
    pub quant: Quant,
    pub model_id: String,
    pub metrics: QuantMetrics,
    pub sharpness: u32,
    pub band: Band,
    /// Where it dulls worst (e.g. "code"), or empty when it holds up evenly.
    pub dulls_on: String,
    /// True when this quant is the measurement reference (graded against itself).
    pub is_reference: bool,
}

/// A model's Quant Truth, ready to serialize to the UI and cache to disk.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuantReport {
    pub base: String,
    pub reference: String,
    pub entries: Vec<QuantEntry>,
    /// The lightest quant that still rides true, by label, if any clears the bar.
    pub sweet_spot: Option<String>,
    pub measured_unix: u64,
    pub calibration_version: u32,
}

/// Sharpness at or above which a quant is considered to still "ride true", so the
/// lightest one clearing it is the sweet spot.
pub const SWEET_SPOT_BAR: u32 = 95;

/// Pick the sweet spot: the lightest (lowest bpw) entry whose sharpness clears
/// the bar, or that is statistically the reference's equal. Pure over entries.
pub fn pick_sweet_spot(entries: &[QuantEntry]) -> Option<String> {
    entries
        .iter()
        .filter(|e| e.band == Band::Reference || e.sharpness >= SWEET_SPOT_BAR)
        .min_by(|a, b| a.quant.bpw.partial_cmp(&b.quant.bpw).unwrap_or(std::cmp::Ordering::Equal))
        .map(|e| e.quant.label.clone())
}

/// Assemble a report from per-(quant, domain) metrics. `measured` maps a quant's
/// model id to its per-domain metrics; `reference_id` is the model id graded as
/// truth. Entries are sorted heaviest-first (reference at the top). Pure.
pub fn build_report(
    base: &str,
    reference_label: &str,
    reference_id: &str,
    measured: &[(Quant, String, BTreeMap<Domain, QuantMetrics>)],
    measured_unix: u64,
) -> QuantReport {
    let mut entries: Vec<QuantEntry> = measured
        .iter()
        .map(|(quant, model_id, by_domain)| {
            let agg = aggregate_domains(by_domain);
            let sharpness = sharpness_pct(&agg);
            let band = band_for(sharpness, agg.kld);
            QuantEntry {
                quant: quant.clone(),
                model_id: model_id.clone(),
                metrics: agg,
                sharpness,
                band,
                dulls_on: worst_domain(by_domain),
                is_reference: model_id == reference_id,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.quant.bpw.partial_cmp(&a.quant.bpw).unwrap_or(std::cmp::Ordering::Equal)
    });
    let sweet_spot = pick_sweet_spot(&entries);
    QuantReport {
        base: base.to_string(),
        reference: reference_label.to_string(),
        entries,
        sweet_spot,
        measured_unix,
        calibration_version: CALIBRATION_VERSION,
    }
}

/// Average a quant's per-domain metrics into one figure. Pure.
pub fn aggregate_domains(by_domain: &BTreeMap<Domain, QuantMetrics>) -> QuantMetrics {
    if by_domain.is_empty() {
        return QuantMetrics { kld: 0.0, top1_agreement: 1.0, ppl_ratio: 1.0 };
    }
    let n = by_domain.len() as f64;
    let mut kld = 0.0;
    let mut top1 = 0.0;
    let mut ppl = 0.0;
    for m in by_domain.values() {
        kld += m.kld;
        top1 += m.top1_agreement;
        ppl += m.ppl_ratio;
    }
    QuantMetrics { kld: kld / n, top1_agreement: top1 / n, ppl_ratio: ppl / n }
}

/// Name the domain a quant dulls on worst, when one stands out (its sharpness is
/// meaningfully below the others). Empty when it holds up evenly. Pure.
pub fn worst_domain(by_domain: &BTreeMap<Domain, QuantMetrics>) -> String {
    if by_domain.len() < 2 {
        return String::new();
    }
    let scored: Vec<(Domain, u32)> =
        by_domain.iter().map(|(d, m)| (*d, sharpness_pct(m))).collect();
    let best = scored.iter().map(|(_, s)| *s).max().unwrap_or(100);
    let (worst_d, worst_s) = scored.iter().min_by_key(|(_, s)| *s).copied().unwrap();
    // Only call it out when the gap is real (>= 4 points).
    if best.saturating_sub(worst_s) >= 4 {
        worst_d.as_str().to_string()
    } else {
        String::new()
    }
}

// ── Calibration domains ─────────────────────────────────────────────────────

/// The kinds of text a quant is graded on, so we can say where it dulls.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Domain {
    General,
    Code,
    LongContext,
}

impl Domain {
    pub fn as_str(&self) -> &'static str {
        match self {
            Domain::General => "general",
            Domain::Code => "code",
            Domain::LongContext => "long context",
        }
    }
    pub fn all() -> &'static [Domain] {
        &[Domain::General, Domain::Code, Domain::LongContext]
    }
    /// The calibration text for this domain. Kept short and fixed: the absolute
    /// perplexity does not matter, only the candidate-vs-reference ratio on the
    /// same bytes, so a representative passage is enough to surface drift.
    pub fn corpus(&self) -> &'static str {
        match self {
            Domain::General => GENERAL_CORPUS,
            Domain::Code => CODE_CORPUS,
            Domain::LongContext => LONG_CORPUS,
        }
    }
}

const GENERAL_CORPUS: &str = "The quiet valley held its breath as the morning fog lifted off the river. \
A rancher counted the herd by the fence line, noting which animals had wandered and which had stayed. \
Reasoning carefully about cause and effect, she traced the broken gate back to a loose hinge, \
then explained to the hands why the simplest fix was usually the right one. \
By noon the work was done, the ledger balanced, and nothing of theirs had left the land.";

const CODE_CORPUS: &str = "fn merge_sorted(a: &[i32], b: &[i32]) -> Vec<i32> {\n\
    let mut out = Vec::with_capacity(a.len() + b.len());\n\
    let (mut i, mut j) = (0, 0);\n\
    while i < a.len() && j < b.len() {\n\
        if a[i] <= b[j] { out.push(a[i]); i += 1; } else { out.push(b[j]); j += 1; }\n\
    }\n\
    out.extend_from_slice(&a[i..]);\n\
    out.extend_from_slice(&b[j..]);\n\
    out\n\
}";

const LONG_CORPUS: &str = "In a longer passage the model must hold earlier facts in mind while reading on. \
The rancher named three horses at the start: Ash, Birch, and Cedar. Ash was the fastest over short \
distances, Birch the steadiest on rough trails, and Cedar the calmest around strangers. Later, when a \
visitor arrived after dark and the trail was washed out, the right choice followed directly from those \
facts stated paragraphs earlier: the steady one for the rough, washed-out trail. A model that has lost \
the thread will reach for the wrong horse, and the divergence shows up exactly here, far from the start.";

// ── On-disk cache ───────────────────────────────────────────────────────────

/// Directory holding cached Quant Truth reports (one JSON per base model).
fn cache_dir() -> std::path::PathBuf {
    crate::config::config_path()
        .parent()
        .map(|p| p.join("quant-truth"))
        .unwrap_or_else(|| std::path::PathBuf::from("quant-truth"))
}

/// Cache file path for a base model. The base name is slugified so it is always
/// a safe single filename.
fn cache_path(base: &str) -> std::path::PathBuf {
    let slug: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    cache_dir().join(format!("{slug}.json"))
}

/// Load a cached report for a base model, if one exists and matches the current
/// calibration version. A stale or unreadable cache returns None (recompute).
pub fn load_cached(base: &str) -> Option<QuantReport> {
    let txt = std::fs::read_to_string(cache_path(base)).ok()?;
    let report: QuantReport = serde_json::from_str(&txt).ok()?;
    if report.calibration_version != CALIBRATION_VERSION {
        return None;
    }
    Some(report)
}

/// Persist a report to the cache (best-effort; a write failure is logged).
pub fn save_cached(report: &QuantReport) {
    let dir = cache_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(txt) = serde_json::to_string_pretty(report) {
        if let Err(e) = std::fs::write(cache_path(&report.base), txt) {
            eprintln!("llamaranch: quant-truth cache write failed: {e}");
        }
    }
}

// ── Router scoring (network; correctness validated on-device) ───────────────

/// Score a calibration text under one model via the router's OpenAI-compatible
/// completions endpoint, returning the per-position distribution we need for the
/// metrics. Uses `echo` + `logprobs` to recover prompt-token probabilities;
/// `n_predict`/`max_tokens` is zero because we score the given text, not a
/// continuation. Returns None on any transport or shape failure (the caller then
/// records the model as unmeasurable rather than guessing).
pub fn score_text(port: u16, model_id: &str, text: &str) -> Option<Vec<PositionScore>> {
    let url = format!("http://127.0.0.1:{port}/v1/completions");
    let body = serde_json::json!({
        "model": model_id,
        "prompt": text,
        "max_tokens": 0,
        "temperature": 0.0,
        "echo": true,
        "logprobs": 8,
    });
    let resp = ureq::post(&url)
        .timeout(Duration::from_secs(300))
        .send_json(body)
        .ok()?;
    let v: serde_json::Value = resp.into_json().ok()?;
    let lp = v.get("choices")?.get(0)?.get("logprobs")?;
    parse_logprobs(lp)
}

/// Turn an OpenAI-style `logprobs` object (`tokens`, `token_logprobs`,
/// `top_logprobs`) into our per-position scores. The first prompt token has a
/// null logprob (nothing precedes it) and is skipped. Pure given the JSON.
pub fn parse_logprobs(lp: &serde_json::Value) -> Option<Vec<PositionScore>> {
    let token_logprobs = lp.get("token_logprobs")?.as_array()?;
    let top = lp.get("top_logprobs")?.as_array()?;
    let mut out = Vec::new();
    for (i, lpv) in token_logprobs.iter().enumerate() {
        let Some(logprob_actual) = lpv.as_f64() else { continue }; // skip null (first token)
        let Some(map) = top.get(i).and_then(|m| m.as_object()) else { continue };
        // top_logprobs[i] is { token: logprob }; convert to (token, prob), find argmax.
        let mut dist: Vec<(String, f64)> =
            map.iter().filter_map(|(k, v)| v.as_f64().map(|lp| (k.clone(), lp.exp()))).collect();
        if dist.is_empty() {
            continue;
        }
        dist.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let top1 = dist[0].0.clone();
        out.push(PositionScore { top1, logprob_actual, dist });
    }
    Some(out)
}

/// Measure one candidate against the reference across all domains, returning its
/// per-domain metrics. Returns None if either model fails to score on any domain.
pub fn measure_candidate(
    port: u16,
    candidate_id: &str,
    reference_id: &str,
) -> Option<BTreeMap<Domain, QuantMetrics>> {
    let mut out = BTreeMap::new();
    for d in Domain::all() {
        let corpus = d.corpus();
        let cand = score_text(port, candidate_id, corpus)?;
        // The reference scores itself too; identical id short-circuits to parity.
        let metrics = if candidate_id == reference_id {
            QuantMetrics { kld: 0.0, top1_agreement: 1.0, ppl_ratio: 1.0 }
        } else {
            let reference = score_text(port, reference_id, corpus)?;
            let cand_ppl = perplexity(&cand.iter().map(|p| p.logprob_actual).collect::<Vec<_>>());
            let ref_ppl =
                perplexity(&reference.iter().map(|p| p.logprob_actual).collect::<Vec<_>>());
            QuantMetrics {
                kld: mean_kld(&cand, &reference),
                top1_agreement: top1_agreement(&cand, &reference),
                ppl_ratio: if ref_ppl > 0.0 { cand_ppl / ref_ppl } else { 1.0 },
            }
        };
        out.insert(*d, metrics);
    }
    Some(out)
}

// ── Installed-model grouping and orchestration ──────────────────────────────

/// Group installed models into quant variants per base model. Only models whose
/// id carries a recognizable quant token participate; others have no size to grade.
pub fn group_variants(models_dir: &str) -> BTreeMap<String, Vec<(Quant, String)>> {
    let mut map: BTreeMap<String, Vec<(Quant, String)>> = BTreeMap::new();
    for m in scanner::scan(Path::new(models_dir)) {
        if let Some(q) = parse_quant(&m.id) {
            map.entry(base_name(&m.id)).or_default().push((q, m.id));
        }
    }
    map
}

/// Current Unix time in seconds (0 if the clock is before the epoch).
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Measure every quant variant of one base model against the highest-precision
/// variant present (the reference), build the report, cache it, and return it.
/// Errs when the base has no installed variants, or when a model fails to score.
pub fn measure_base(port: u16, models_dir: &str, base: &str) -> Result<QuantReport, String> {
    let variants = group_variants(models_dir);
    let list = variants
        .get(base)
        .filter(|l| !l.is_empty())
        .ok_or_else(|| format!("no installed quants for {base}"))?;

    // Reference = highest bits-per-weight present locally (fits where the lighter
    // ones fit, so it can run on the same machine).
    let reference = list
        .iter()
        .max_by(|a, b| a.0.bpw.partial_cmp(&b.0.bpw).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap();
    let reference_id = reference.1.clone();
    let reference_label = reference.0.label.clone();

    let mut measured = Vec::with_capacity(list.len());
    for (q, id) in list {
        let by_domain = measure_candidate(port, id, &reference_id)
            .ok_or_else(|| format!("could not score {id} against {reference_id}"))?;
        measured.push((q.clone(), id.clone(), by_domain));
    }

    let report = build_report(base, &reference_label, &reference_id, &measured, now_unix());
    save_cached(&report);
    Ok(report)
}

/// Background sweep: measure every base model that has more than one quant
/// variant and no fresh cached report. Returns how many were measured. A model
/// that fails to score is skipped rather than aborting the sweep.
pub fn measure_pending(port: u16, models_dir: &str) -> usize {
    let mut done = 0;
    for (base, list) in group_variants(models_dir) {
        if list.len() < 2 {
            continue; // nothing to compare a single variant against
        }
        if load_cached(&base).is_some() {
            continue; // already measured at the current calibration version
        }
        if measure_base(port, models_dir, &base).is_ok() {
            done += 1;
        }
    }
    done
}

/// Return the cached quality report for a base model, if one exists.
#[tauri::command]
pub fn quality_report(base: String) -> Option<QuantReport> {
    load_cached(&base)
}

/// Measure a base model now (the "Measure this one" button), returning the report.
#[tauri::command]
pub fn measure_quality(base: String, cfg: State<AppConfig>) -> Result<QuantReport, String> {
    let (port, models_dir) = {
        let c = cfg.0.lock().unwrap();
        (c.port, c.models_dir.clone())
    };
    measure_base(port, &models_dir, &base)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── quant parsing ──
    #[test]
    fn parses_specific_quant_tokens() {
        assert_eq!(parse_quant("Qwen3-8B-Q4_K_M.gguf").unwrap().label, "Q4_K_M");
        assert_eq!(parse_quant("model.q6_k.gguf").unwrap().label, "Q6_K");
        assert_eq!(parse_quant("Llama-3.2-3B-IQ4_XS.gguf").unwrap().label, "IQ4_XS");
        assert_eq!(parse_quant("x-F16.gguf").unwrap().label, "F16");
        assert!(parse_quant("no-quant-here.gguf").is_none());
    }

    #[test]
    fn q4_k_m_beats_q4_before_more_specific() {
        // Must not match the bare "Q4" inside "Q4_K_M".
        let q = parse_quant("foo-Q4_K_M.gguf").unwrap();
        assert_eq!(q.label, "Q4_K_M");
    }

    #[test]
    fn base_name_strips_quant_and_ext() {
        assert_eq!(base_name("Qwen3-8B-Q4_K_M.gguf"), "Qwen3-8B");
        assert_eq!(base_name("gemma-3-4b-it-Q6_K.gguf"), "gemma-3-4b-it");
        assert_eq!(base_name("plain-model.gguf"), "plain-model");
    }

    #[test]
    fn higher_bpw_ranks_above_lower() {
        assert!(parse_quant("a-Q8_0").unwrap().bpw > parse_quant("a-Q4_K_M").unwrap().bpw);
        assert!(parse_quant("a-Q6_K").unwrap().bpw > parse_quant("a-Q3_K_S").unwrap().bpw);
    }

    // ── perplexity ──
    #[test]
    fn perplexity_of_certainty_is_one() {
        // logprob 0 == probability 1 for every token → no surprise.
        assert!((perplexity(&[0.0, 0.0, 0.0]) - 1.0).abs() < 1e-9);
    }
    #[test]
    fn perplexity_empty_is_one() {
        assert_eq!(perplexity(&[]), 1.0);
    }
    #[test]
    fn perplexity_grows_with_surprise() {
        let low = perplexity(&[-0.1, -0.1]);
        let high = perplexity(&[-2.0, -2.0]);
        assert!(high > low);
        assert!((perplexity(&[-1.0, -1.0]) - std::f64::consts::E).abs() < 1e-9);
    }

    fn ps(top1: &str, lp: f64, dist: &[(&str, f64)]) -> PositionScore {
        PositionScore {
            top1: top1.to_string(),
            logprob_actual: lp,
            dist: dist.iter().map(|(t, p)| (t.to_string(), *p)).collect(),
        }
    }

    // ── top1 agreement ──
    #[test]
    fn top1_agreement_counts_matches() {
        let cand = vec![ps("a", -0.1, &[("a", 0.9)]), ps("x", -0.1, &[("x", 0.9)])];
        let reference = vec![ps("a", -0.1, &[("a", 0.9)]), ps("b", -0.1, &[("b", 0.9)])];
        assert!((top1_agreement(&cand, &reference) - 0.5).abs() < 1e-9);
    }
    #[test]
    fn top1_agreement_empty_is_one() {
        assert_eq!(top1_agreement(&[], &[]), 1.0);
    }

    // ── KLD ──
    #[test]
    fn kld_identical_distributions_is_zero() {
        let a = vec![ps("a", -0.1, &[("a", 0.7), ("b", 0.3)])];
        assert!(mean_kld(&a, &a) < 1e-9);
    }
    #[test]
    fn kld_grows_as_distributions_diverge() {
        let reference = vec![ps("a", -0.1, &[("a", 0.9), ("b", 0.1)])];
        let near = vec![ps("a", -0.1, &[("a", 0.85), ("b", 0.15)])];
        let far = vec![ps("b", -0.1, &[("b", 0.9), ("a", 0.1)])];
        assert!(mean_kld(&near, &reference) < mean_kld(&far, &reference));
    }
    #[test]
    fn kld_penalizes_dropped_reference_token() {
        // Reference puts mass on "b"; candidate never lists it → large divergence.
        let reference = vec![ps("a", -0.1, &[("a", 0.5), ("b", 0.5)])];
        let candidate = vec![ps("a", -0.1, &[("a", 1.0)])];
        assert!(mean_kld(&candidate, &reference) > 1.0);
    }

    // ── grading ──
    #[test]
    fn sharpness_full_at_parity() {
        let m = QuantMetrics { kld: 0.0, top1_agreement: 1.0, ppl_ratio: 1.0 };
        assert_eq!(sharpness_pct(&m), 100);
    }
    #[test]
    fn sharpness_drops_with_disagreement_and_ppl() {
        let m = QuantMetrics { kld: 0.3, top1_agreement: 0.6, ppl_ratio: 1.5 };
        let s = sharpness_pct(&m);
        assert!(s < 80, "expected a clear drop, got {s}");
    }
    #[test]
    fn band_reference_when_indistinguishable() {
        assert_eq!(band_for(94, 0.001), Band::Reference);
    }
    #[test]
    fn band_tracks_sharpness_when_distinguishable() {
        assert_eq!(band_for(99, 0.2), Band::Crisp);
        assert_eq!(band_for(94, 0.2), Band::Solid);
        assert_eq!(band_for(88, 0.2), Band::Soft);
        assert_eq!(band_for(70, 0.2), Band::Rough);
    }

    // ── sweet spot ──
    fn entry(label: &str, bpw: f32, sharpness: u32, band: Band) -> QuantEntry {
        QuantEntry {
            quant: Quant { label: label.to_string(), bpw },
            model_id: label.to_string(),
            metrics: QuantMetrics { kld: 0.2, top1_agreement: 0.9, ppl_ratio: 1.1 },
            sharpness,
            band,
            dulls_on: String::new(),
            is_reference: false,
        }
    }

    #[test]
    fn sweet_spot_is_lightest_that_clears_the_bar() {
        let entries = vec![
            entry("Q8_0", 8.5, 100, Band::Reference),
            entry("Q6_K", 6.56, 99, Band::Crisp),
            entry("Q4_K_M", 4.85, 96, Band::Solid),
            entry("Q3_K_S", 3.5, 84, Band::Rough),
        ];
        assert_eq!(pick_sweet_spot(&entries).as_deref(), Some("Q4_K_M"));
    }
    #[test]
    fn sweet_spot_none_when_all_rough() {
        let entries = vec![entry("Q3_K_S", 3.5, 80, Band::Rough), entry("Q2_K", 3.35, 70, Band::Rough)];
        assert_eq!(pick_sweet_spot(&entries), None);
    }

    // ── domains ──
    #[test]
    fn worst_domain_called_out_only_on_real_gap() {
        let mut even = BTreeMap::new();
        even.insert(Domain::General, QuantMetrics { kld: 0.1, top1_agreement: 0.97, ppl_ratio: 1.05 });
        even.insert(Domain::Code, QuantMetrics { kld: 0.1, top1_agreement: 0.96, ppl_ratio: 1.05 });
        assert_eq!(worst_domain(&even), ""); // within 4 points

        let mut skewed = BTreeMap::new();
        skewed.insert(Domain::General, QuantMetrics { kld: 0.1, top1_agreement: 0.98, ppl_ratio: 1.02 });
        skewed.insert(Domain::Code, QuantMetrics { kld: 0.4, top1_agreement: 0.70, ppl_ratio: 1.4 });
        assert_eq!(worst_domain(&skewed), "code");
    }

    // ── report assembly ──
    #[test]
    fn build_report_sorts_and_picks_sweet_spot() {
        let mk = |t: f64, p: f64, k: f64| {
            let mut m = BTreeMap::new();
            m.insert(Domain::General, QuantMetrics { kld: k, top1_agreement: t, ppl_ratio: p });
            m
        };
        let measured = vec![
            (Quant { label: "Q8_0".into(), bpw: 8.5 }, "ref".to_string(), mk(1.0, 1.0, 0.0)),
            (Quant { label: "Q4_K_M".into(), bpw: 4.85 }, "q4".to_string(), mk(0.965, 1.05, 0.2)),
            (Quant { label: "Q3_K_S".into(), bpw: 3.5 }, "q3".to_string(), mk(0.80, 1.4, 0.5)),
        ];
        let r = build_report("Qwen3-8B", "Q8_0", "ref", &measured, 1234);
        assert_eq!(r.entries[0].quant.label, "Q8_0"); // heaviest first
        assert!(r.entries[0].is_reference);
        assert_eq!(r.entries[0].band, Band::Reference);
        assert_eq!(r.calibration_version, CALIBRATION_VERSION);
        assert_eq!(r.sweet_spot.as_deref(), Some("Q4_K_M"));
    }

    // ── logprobs parsing ──
    #[test]
    fn parse_logprobs_skips_null_first_token() {
        let lp = serde_json::json!({
            "tokens": ["The", " valley"],
            "token_logprobs": [null, -0.5],
            "top_logprobs": [null, { " valley": -0.5, " river": -1.2 }],
        });
        let scores = parse_logprobs(&lp).unwrap();
        assert_eq!(scores.len(), 1); // first (null) skipped
        assert_eq!(scores[0].top1, " valley");
        assert!((scores[0].logprob_actual + 0.5).abs() < 1e-9);
        assert_eq!(scores[0].dist.len(), 2);
    }
}
