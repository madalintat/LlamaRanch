//! Real embedding gate: route by cosine similarity to per-category centroids,
//! computed lazily from seed phrases via the router's /v1/embeddings. Any
//! failure returns None so the router falls back to the classifier.
use super::{Category, EmbeddingGate};
use std::sync::Mutex;
use std::time::Duration;

/// Managed state that holds the centroid cache across turns.
#[derive(Default)]
pub struct GateCache(pub Mutex<Option<Vec<(Category, Vec<f32>)>>>);

/// Cosine similarity of two equal-length vectors. 0.0 on length mismatch or zero norm.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Highest-similarity centroid for `query`, or None if there are no centroids.
pub fn best_centroid(query: &[f32], centroids: &[(Category, Vec<f32>)]) -> Option<(Category, f32)> {
    let mut best: Option<(Category, f32)> = None;
    for (cat, c) in centroids {
        let s = cosine(query, c);
        if best.as_ref().map_or(true, |(_, bs)| s > *bs) {
            best = Some((*cat, s));
        }
    }
    best
}

const SEEDS: &[(Category, &[&str])] = &[
    (Category::Code, &[
        "write a function", "fix this bug", "refactor this code",
        "what does this error mean", "implement an algorithm",
    ]),
    (Category::Reasoning, &[
        "prove that", "solve this step by step", "explain the logic",
        "think through this problem", "what is the proof",
    ]),
    (Category::General, &[
        "tell me about", "what is", "summarize this", "help me write", "give me advice",
    ]),
];

/// Embedding-similarity gate. Lazily builds centroids; degrades to None on any failure.
/// Borrows a `GateCache` from managed app state so the cache persists across turns.
pub struct EmbedGate<'a> {
    port: u16,
    model: String,
    cache: &'a GateCache,
}

impl<'a> EmbedGate<'a> {
    pub fn new(port: u16, model: String, cache: &'a GateCache) -> Self {
        EmbedGate { port, model, cache }
    }

    fn ensure_centroids(&self) -> Option<Vec<(Category, Vec<f32>)>> {
        if let Some(c) = self.cache.0.lock().unwrap().clone() {
            return Some(c);
        }
        // Make sure the embedding model is resident (best-effort).
        let _ = crate::server::load(self.port, &self.model);
        let mut built = Vec::new();
        for (cat, seeds) in SEEDS {
            let mut acc: Vec<f32> = Vec::new();
            let mut n = 0u32;
            for s in *seeds {
                if let Some(v) = self.embed(s) {
                    if acc.is_empty() {
                        acc = vec![0.0; v.len()];
                    }
                    if acc.len() == v.len() {
                        for i in 0..acc.len() {
                            acc[i] += v[i];
                        }
                        n += 1;
                    }
                }
            }
            if n == 0 {
                return None; // embedding unavailable → stay uninitialized
            }
            for x in acc.iter_mut() {
                *x /= n as f32;
            }
            built.push((*cat, acc));
        }
        *self.cache.0.lock().unwrap() = Some(built.clone());
        Some(built)
    }

    fn embed(&self, text: &str) -> Option<Vec<f32>> {
        let url = format!("http://127.0.0.1:{}/v1/embeddings", self.port);
        let body = serde_json::json!({ "model": self.model, "input": text });
        let resp = ureq::post(&url)
            .timeout(Duration::from_secs(20))
            .send_json(body)
            .ok()?;
        let v: serde_json::Value = resp.into_json().ok()?;
        let arr = v.get("data")?.get(0)?.get("embedding")?.as_array()?;
        let out: Vec<f32> = arr.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect();
        if out.is_empty() { None } else { Some(out) }
    }
}

impl EmbeddingGate for EmbedGate<'_> {
    fn category(&self, text: &str) -> Option<(Category, f32)> {
        let centroids = self.ensure_centroids()?;
        let q = self.embed(text)?;
        best_centroid(&q, &centroids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_identical_is_one() {
        assert!((cosine(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]) - 1.0).abs() < 1e-6);
    }
    #[test]
    fn cosine_orthogonal_is_zero() {
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }
    #[test]
    fn cosine_mismatch_or_empty_is_zero() {
        assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0);
        assert_eq!(cosine(&[], &[]), 0.0);
    }
    #[test]
    fn best_centroid_picks_max_and_none_on_empty() {
        let c = vec![
            (Category::Code, vec![1.0, 0.0]),
            (Category::General, vec![0.0, 1.0]),
        ];
        assert_eq!(best_centroid(&[0.9, 0.1], &c).unwrap().0, Category::Code);
        assert_eq!(best_centroid(&[0.9, 0.1], &[]), None);
    }
}
