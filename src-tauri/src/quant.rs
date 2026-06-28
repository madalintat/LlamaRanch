//! Model quality: measure, on this machine, how much quality a quantized model
//! actually lost against a near-lossless reference, and name the sweet spot.
//!
//! A local model is a shrunk model. Almost nothing tells you how much it lost,
//! so people run on forum lore. Here we measure it with llama.cpp's own
//! `llama-perplexity --kl-divergence`, which reports perplexity, KL-divergence,
//! and top-token agreement against a saved reference. The grading and the
//! output parser are pure and unit-tested; only the measurement spawns the
//! binary. The honest part: KL-divergence cleanly separates aggressive quants
//! but goes blind near the reference, so below a noise floor we call two sizes
//! the reference's equal rather than inventing a gap.
use crate::commands::AppConfig;
use crate::scanner;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use tauri::State;

/// Bump when the calibration corpus, the metric definitions, or the grade
/// thresholds change, so stale cached reports are recomputed rather than trusted.
pub const CALIBRATION_VERSION: u32 = 2;

/// Context length for the perplexity pass. One 512-token chunk is enough to
/// surface drift on the calibration corpus, and keeps the run quick.
const QUANT_CTX: u32 = 512;

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
        // Remove the quant token wherever it sits.
        let up = s.to_ascii_uppercase();
        if let Some(pos) = up.find(&q.label) {
            s = format!("{}{}", &s[..pos], &s[pos + q.label.len()..]);
        }
    }
    s.trim_matches(['-', '_', '.', ' ']).to_string()
}

// ── Measured metrics ────────────────────────────────────────────────────────

/// The three quality signals `llama-perplexity --kl-divergence` reports for a
/// candidate against the reference. All point the same way: lower divergence and
/// higher agreement mean the candidate behaves more like the reference.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuantMetrics {
    /// Mean KL-divergence of the candidate from the reference, in nats. ~0 means
    /// indistinguishable; large means the distributions parted ways.
    pub kld: f64,
    /// Fraction of positions where the candidate's top token matched the
    /// reference's (llama.cpp's "Same top p", as a 0..=1 fraction).
    pub top1_agreement: f64,
    /// Candidate perplexity divided by reference perplexity (llama.cpp's
    /// "Mean PPL(Q)/PPL(base)"). ~1.0 at parity; higher means more surprised.
    pub ppl_ratio: f64,
}

// ── Grade thresholds (calibrated to published per-quant KLD/PPL numbers) ─────
//
// KLD bands in nats, after smcleod.net's "Measuring Model Quantisation Quality
// with KL Divergence" and the per-quant perplexity deltas in the community
// "Q4 vs Q5 vs Q6 vs Q8" quality-loss tables: <1e-3 is indistinguishable from
// the reference (Q8/Q6 land here), 1e-2 is well-made 5-6 bit, the 4-bit sweet
// spot (Q4_K_M) sits around 1e-2..3e-2, 3-bit drifts into 3e-2..1e-1, and 2-bit
// and below exceeds 1e-1 with outputs that obviously differ.

/// Below this mean KLD a candidate is statistically too close to the reference
/// to call apart. This is the honesty floor: we refuse to invent a difference
/// the measurement cannot actually see.
pub const KLD_LOSSLESS: f64 = 1e-3;
/// Up to here the loss is very small (well-made 5-6 bit).
pub const KLD_CRISP: f64 = 1e-2;
/// Up to here the loss is small but real: the 4-bit sweet-spot band.
pub const KLD_SOLID: f64 = 3e-2;
/// Up to here the loss is noticeable (3-bit). Beyond it, rough (2-bit and below).
pub const KLD_SOFT: f64 = 1e-1;

// ── Grading (pure, unit-tested) ─────────────────────────────────────────────

/// How a quant lands, as a plain word.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Band {
    /// Effectively the reference: too close to call apart.
    Reference,
    /// Crisp: keeps almost all of the sharpness.
    Crisp,
    /// Solid: a small, safe loss (the 4-bit sweet spot).
    Solid,
    /// Soft: a real loss you can feel.
    Soft,
    /// Rough: noticeably dulled.
    Rough,
}

/// A 0..=100 "sharpness" score: how often the quant picks the reference's next
/// token. Directly interpretable and read straight from the measurement. Pure.
pub fn sharpness_pct(m: &QuantMetrics) -> u32 {
    (m.top1_agreement.clamp(0.0, 1.0) * 100.0).round() as u32
}

/// Band a quant from its mean KL-divergence against the reference. KLD is the
/// robust, published metric, so the grade rides on it. Pure.
pub fn band_for(kld: f64) -> Band {
    if kld < KLD_LOSSLESS {
        Band::Reference
    } else if kld < KLD_CRISP {
        Band::Crisp
    } else if kld < KLD_SOLID {
        Band::Solid
    } else if kld < KLD_SOFT {
        Band::Soft
    } else {
        Band::Rough
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
    /// True when this quant is the measurement reference (graded against itself).
    pub is_reference: bool,
}

/// A model's quality report, ready to serialize to the UI and cache to disk.
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

/// Pick the sweet spot: the lightest (lowest bpw) entry that still grades Solid
/// or better, i.e. the smallest size whose quality loss is at most "small but
/// real". Pure over entries.
pub fn pick_sweet_spot(entries: &[QuantEntry]) -> Option<String> {
    entries
        .iter()
        .filter(|e| matches!(e.band, Band::Reference | Band::Crisp | Band::Solid))
        .min_by(|a, b| a.quant.bpw.partial_cmp(&b.quant.bpw).unwrap_or(std::cmp::Ordering::Equal))
        .map(|e| e.quant.label.clone())
}

/// Assemble a report from per-quant metrics. `reference_id` is the model id
/// graded as truth. Entries are sorted heaviest-first (reference at the top).
/// Pure.
pub fn build_report(
    base: &str,
    reference_label: &str,
    reference_id: &str,
    measured: &[(Quant, String, QuantMetrics)],
    measured_unix: u64,
) -> QuantReport {
    let mut entries: Vec<QuantEntry> = measured
        .iter()
        .map(|(quant, model_id, metrics)| QuantEntry {
            quant: quant.clone(),
            model_id: model_id.clone(),
            metrics: *metrics,
            sharpness: sharpness_pct(metrics),
            band: band_for(metrics.kld),
            is_reference: model_id == reference_id,
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

// ── Calibration corpus ──────────────────────────────────────────────────────

/// The fixed text every quant is scored on. Absolute perplexity does not matter,
/// only the candidate-vs-reference comparison on the same tokens, so a
/// representative passage (prose, reasoning, and a little code) is enough to
/// surface drift. Verified on-device to tokenize past the >=2x-ctx minimum that
/// `llama-perplexity` requires at `QUANT_CTX` (about 1.2k tokens, two chunks at
/// 512). Changing it must bump `CALIBRATION_VERSION`.
const CALIBRATION_CORPUS: &str = include_str!("quant_corpus.txt");

// ── llama-perplexity output parsing (pure, unit-tested) ──────────────────────

/// First parseable float in a fragment, skipping whitespace, the `±` uncertainty
/// marker, and a trailing `%`. Returns the mean (the first number), not the
/// uncertainty after it. Pure.
fn parse_first_float(s: &str) -> Option<f64> {
    s.split(|c: char| c.is_whitespace() || c == '\u{00b1}' || c == '%')
        .find_map(|t| t.parse::<f64>().ok())
}

/// Parse the three quality figures out of `llama-perplexity --kl-divergence`
/// output: `Mean PPL(Q)/PPL(base)`, `Mean KLD`, and `Same top p` (a percentage,
/// returned as a 0..=1 fraction). Returns None if any of the three is missing.
/// Pure given the captured stdout/stderr text.
pub fn parse_perplexity_output(text: &str) -> Option<QuantMetrics> {
    let mut ppl_ratio = None;
    let mut kld = None;
    let mut top1 = None;
    for raw in text.lines() {
        let l = raw.trim();
        if l.starts_with("Mean PPL(Q)/PPL(base)") {
            ppl_ratio = l.split(':').nth(1).and_then(parse_first_float);
        } else if l.starts_with("Mean") && l.contains("KLD:") {
            kld = l.split("KLD:").nth(1).and_then(parse_first_float);
        } else if l.starts_with("Same top p:") {
            top1 = l.split(':').nth(1).and_then(parse_first_float).map(|p| p / 100.0);
        }
    }
    Some(QuantMetrics { kld: kld?, top1_agreement: top1?, ppl_ratio: ppl_ratio? })
}

// ── On-disk cache ───────────────────────────────────────────────────────────

/// A filesystem-safe slug for a base model name.
fn slug(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect()
}

/// Directory holding cached quality reports (one JSON per base model).
fn cache_dir() -> std::path::PathBuf {
    crate::config::config_path()
        .parent()
        .map(|p| p.join("quality"))
        .unwrap_or_else(|| std::path::PathBuf::from("quality"))
}

/// Cache file path for a base model.
fn cache_path(base: &str) -> std::path::PathBuf {
    cache_dir().join(format!("{}.json", slug(base)))
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
            eprintln!("llamaranch: quality cache write failed: {e}");
        }
    }
}

// ── Measurement (spawns llama-perplexity) ────────────────────────────────────

/// Derive the `llama-perplexity` binary path from the `llama-server` path: they
/// ship side by side, so the perplexity tool is the server path with the binary
/// name swapped.
pub fn perplexity_bin(server_bin: &str) -> String {
    server_bin.replace("llama-server", "llama-perplexity")
}

/// Save the reference model's logits over the calibration corpus to `out_logits`
/// (one pass). Returns true on success and a written file.
fn save_reference_logits(bin: &str, model_path: &str, corpus: &Path, out_logits: &Path) -> bool {
    let ran = Command::new(bin)
        .args([
            "-m",
            model_path,
            "-f",
            &corpus.to_string_lossy(),
            "--kl-divergence-base",
            &out_logits.to_string_lossy(),
            "-c",
            &QUANT_CTX.to_string(),
            "--no-warmup",
        ])
        .output();
    matches!(ran, Ok(ref o) if o.status.success()) && out_logits.exists()
}

/// Score one candidate against the saved reference logits, parsing its metrics
/// from the tool output. Returns None on a spawn/parse failure.
fn run_kld(bin: &str, model_path: &str, corpus: &Path, ref_logits: &Path) -> Option<QuantMetrics> {
    let out = Command::new(bin)
        .args([
            "-m",
            model_path,
            "-f",
            &corpus.to_string_lossy(),
            "--kl-divergence",
            "--kl-divergence-base",
            &ref_logits.to_string_lossy(),
            "-c",
            &QUANT_CTX.to_string(),
            "--no-warmup",
        ])
        .output()
        .ok()?;
    // The stats table and the log lines split across stdout/stderr depending on
    // the build, so parse both.
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    parse_perplexity_output(&combined)
}

/// Installed quant variants per base model: only models whose id carries a
/// recognizable quant token participate. Each entry is (quant, model id, path).
pub fn group_variants(models_dir: &str) -> BTreeMap<String, Vec<(Quant, String, String)>> {
    let mut map: BTreeMap<String, Vec<(Quant, String, String)>> = BTreeMap::new();
    for m in scanner::scan(Path::new(models_dir)) {
        if let Some(q) = parse_quant(&m.id) {
            map.entry(base_name(&m.id)).or_default().push((q, m.id, m.path));
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
/// variant present (the reference) using `llama-perplexity`, build the report,
/// cache it, and return it. Errs when the perplexity binary is missing, the base
/// has no installed variants, or a model fails to score.
pub fn measure_base(perplexity_bin: &str, models_dir: &str, base: &str) -> Result<QuantReport, String> {
    if !Path::new(perplexity_bin).exists() {
        return Err(format!("llama-perplexity not found at {perplexity_bin}"));
    }
    let variants = group_variants(models_dir);
    let list = variants
        .get(base)
        .filter(|l| !l.is_empty())
        .ok_or_else(|| format!("no installed quants for {base}"))?;

    // Reference = highest bits-per-weight present locally.
    let reference = list
        .iter()
        .max_by(|a, b| a.0.bpw.partial_cmp(&b.0.bpw).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap();
    let reference_id = reference.1.clone();
    let reference_label = reference.0.label.clone();
    let reference_path = reference.2.clone();

    // Workspace for the calibration corpus and the saved reference logits.
    let work = std::env::temp_dir().join(format!("llamaranch-quality-{}", slug(base)));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let corpus_file = work.join("calibration.txt");
    std::fs::write(&corpus_file, CALIBRATION_CORPUS).map_err(|e| e.to_string())?;
    let ref_logits = work.join("reference.logits");

    // Score the reference once; reuse its logits for every candidate.
    if !save_reference_logits(perplexity_bin, &reference_path, &corpus_file, &ref_logits) {
        let _ = std::fs::remove_dir_all(&work);
        return Err(format!("could not score reference {reference_id}"));
    }

    let mut measured = Vec::with_capacity(list.len());
    for (q, id, path) in list {
        let metrics = if *id == reference_id {
            // The reference graded against itself is parity by definition.
            QuantMetrics { kld: 0.0, top1_agreement: 1.0, ppl_ratio: 1.0 }
        } else {
            match run_kld(perplexity_bin, path, &corpus_file, &ref_logits) {
                Some(m) => m,
                None => {
                    let _ = std::fs::remove_dir_all(&work);
                    return Err(format!("could not score {id} against {reference_id}"));
                }
            }
        };
        measured.push((q.clone(), id.clone(), metrics));
    }
    let _ = std::fs::remove_dir_all(&work);

    let report = build_report(base, &reference_label, &reference_id, &measured, now_unix());
    save_cached(&report);
    Ok(report)
}

/// Background sweep: measure every base model that has more than one quant
/// variant and no fresh cached report. Returns how many were measured. A model
/// that fails to score is skipped rather than aborting the sweep.
pub fn measure_pending(perplexity_bin: &str, models_dir: &str) -> usize {
    let mut done = 0;
    for (base, list) in group_variants(models_dir) {
        if list.len() < 2 {
            continue; // nothing to compare a single variant against
        }
        if load_cached(&base).is_some() {
            continue; // already measured at the current calibration version
        }
        if measure_base(perplexity_bin, models_dir, &base).is_ok() {
            done += 1;
        }
    }
    done
}

/// Return the cached quality report for the model's base family, if one exists.
/// Takes any model id; the base family is derived from it.
#[tauri::command]
pub fn quality_report(model_id: String) -> Option<QuantReport> {
    load_cached(&base_name(&model_id))
}

/// Measure a model's base family now (the "measure quality" button), returning
/// the report. Takes any model id; the base family is derived from it.
#[tauri::command]
pub fn measure_quality(model_id: String, cfg: State<AppConfig>) -> Result<QuantReport, String> {
    let (server_bin, models_dir) = {
        let c = cfg.0.lock().unwrap();
        (c.server_bin.clone(), c.models_dir.clone())
    };
    measure_base(&perplexity_bin(&server_bin), &models_dir, &base_name(&model_id))
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
        assert_eq!(parse_quant("foo-Q4_K_M.gguf").unwrap().label, "Q4_K_M");
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

    // ── grading ──
    #[test]
    fn sharpness_is_top_token_agreement() {
        let m = QuantMetrics { kld: 0.0, top1_agreement: 1.0, ppl_ratio: 1.0 };
        assert_eq!(sharpness_pct(&m), 100);
        let m = QuantMetrics { kld: 0.013, top1_agreement: 0.967, ppl_ratio: 1.009 };
        assert_eq!(sharpness_pct(&m), 97); // 96.7 rounds to 97
    }

    #[test]
    fn band_tracks_published_kld_cutoffs() {
        assert_eq!(band_for(0.0), Band::Reference); // self vs self
        assert_eq!(band_for(5e-4), Band::Reference); // below the noise floor
        assert_eq!(band_for(5e-3), Band::Crisp); // well-made 5-6 bit
        assert_eq!(band_for(2e-2), Band::Solid); // 4-bit sweet spot
        assert_eq!(band_for(6e-2), Band::Soft); // 3-bit, noticeable
        assert_eq!(band_for(0.2), Band::Rough); // 2-bit, obviously different
    }

    // ── sweet spot ──
    fn entry(label: &str, bpw: f32, kld: f64) -> QuantEntry {
        let metrics = QuantMetrics { kld, top1_agreement: 0.97, ppl_ratio: 1.01 };
        QuantEntry {
            quant: Quant { label: label.to_string(), bpw },
            model_id: label.to_string(),
            metrics,
            sharpness: sharpness_pct(&metrics),
            band: band_for(kld),
            is_reference: false,
        }
    }

    #[test]
    fn sweet_spot_is_lightest_solid_or_better() {
        let entries = vec![
            entry("Q8_0", 8.5, 0.0),     // reference
            entry("Q6_K", 6.56, 5e-3),   // crisp
            entry("Q4_K_M", 4.85, 2e-2), // solid
            entry("Q3_K_S", 3.5, 8e-2),  // soft
        ];
        assert_eq!(pick_sweet_spot(&entries).as_deref(), Some("Q4_K_M"));
    }

    #[test]
    fn sweet_spot_none_when_all_soft_or_rough() {
        let entries = vec![entry("Q3_K_S", 3.5, 7e-2), entry("Q2_K", 3.35, 0.3)];
        assert_eq!(pick_sweet_spot(&entries), None);
    }

    // ── report assembly ──
    #[test]
    fn build_report_sorts_and_picks_sweet_spot() {
        let measured = vec![
            (Quant { label: "Q8_0".into(), bpw: 8.5 }, "ref".to_string(),
             QuantMetrics { kld: 0.0, top1_agreement: 1.0, ppl_ratio: 1.0 }),
            (Quant { label: "Q4_K_M".into(), bpw: 4.85 }, "q4".to_string(),
             QuantMetrics { kld: 2e-2, top1_agreement: 0.967, ppl_ratio: 1.009 }),
            (Quant { label: "Q3_K_S".into(), bpw: 3.5 }, "q3".to_string(),
             QuantMetrics { kld: 8e-2, top1_agreement: 0.91, ppl_ratio: 1.05 }),
        ];
        let r = build_report("Qwen3-8B", "Q8_0", "ref", &measured, 1234);
        assert_eq!(r.entries[0].quant.label, "Q8_0"); // heaviest first
        assert!(r.entries[0].is_reference);
        assert_eq!(r.entries[0].band, Band::Reference);
        assert_eq!(r.calibration_version, CALIBRATION_VERSION);
        assert_eq!(r.sweet_spot.as_deref(), Some("Q4_K_M"));
    }

    // ── perplexity-output parsing (against real llama-perplexity output) ──
    #[test]
    fn parse_real_self_vs_self_output() {
        // Captured from `llama-perplexity --kl-divergence` of a model against its
        // own logits: parity (KLD ~0, top p 100%, ppl ratio 1.0).
        let text = "\
Mean PPL(Q)/PPL(base)         :   1.000000 ±   0.000002
====== KL divergence statistics ======
Mean    KLD:  -0.000000 ±   0.000000
Maximum KLD:   0.000035
99.9%   KLD:   0.000032
====== Token probability statistics ======
Same top p: 100.000 ± 0.000 %";
        let m = parse_perplexity_output(text).unwrap();
        assert!(m.kld.abs() < 1e-6);
        assert!((m.top1_agreement - 1.0).abs() < 1e-9);
        assert!((m.ppl_ratio - 1.0).abs() < 1e-9);
    }

    #[test]
    fn parse_degraded_quant_output() {
        let text = "\
Mean PPL(Q)/PPL(base)         :   1.008900 ±   0.001000
Mean ln(PPL(Q)/PPL(base))     :   0.008860 ±   0.001000
====== KL divergence statistics ======
Mean    KLD:   0.013500 ±   0.000400
Maximum KLD:   0.250000
Same top p: 96.700 ± 0.050 %";
        let m = parse_perplexity_output(text).unwrap();
        assert!((m.kld - 0.0135).abs() < 1e-9);
        assert!((m.top1_agreement - 0.967).abs() < 1e-9);
        assert!((m.ppl_ratio - 1.0089).abs() < 1e-9);
        assert_eq!(sharpness_pct(&m), 97);
        assert_eq!(band_for(m.kld), Band::Solid);
    }

    #[test]
    fn parse_returns_none_when_incomplete() {
        assert!(parse_perplexity_output("Mean    KLD:   0.01").is_none()); // no ppl/top-p
        assert!(parse_perplexity_output("nothing useful here").is_none());
    }

    // ── binary path derivation ──
    #[test]
    fn perplexity_bin_swaps_the_binary_name() {
        assert_eq!(perplexity_bin("/opt/homebrew/bin/llama-server"), "/opt/homebrew/bin/llama-perplexity");
        assert_eq!(perplexity_bin("C:\\llama\\llama-server.exe"), "C:\\llama\\llama-perplexity.exe");
    }
}
