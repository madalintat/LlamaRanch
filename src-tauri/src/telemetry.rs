//! Routing telemetry: a legible record of which expert each turn went to and
//! why path it came through (in-app chat or the gateway). Kept as a bounded ring
//! in memory plus a best-effort append to `activity.jsonl`, so the ranch can show
//! what it has actually been doing and, later, tune routing from real history.
use serde::Serialize;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::Mutex;

/// One routing decision. `seq` is a monotonic counter (ordering without clocks).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RouteEvent {
    pub seq: u64,
    pub model: String,
    pub category: String,
    pub via_gateway: bool,
}

#[derive(Default)]
struct Inner {
    seq: u64,
    ring: VecDeque<RouteEvent>,
}

/// Managed telemetry state. Recording holds the lock only briefly.
#[derive(Default)]
pub struct Telemetry(Mutex<Inner>);

/// Keep the most recent N decisions in memory; older ones live only in the log.
const CAP: usize = 200;

impl Telemetry {
    /// Record one routing decision. Never fails a turn: the JSONL append is
    /// best-effort and the in-memory ring is trimmed to `CAP`.
    pub fn record(&self, model: &str, category: &str, via_gateway: bool) {
        let mut g = self.0.lock().unwrap();
        g.seq += 1;
        let ev = RouteEvent {
            seq: g.seq,
            model: model.to_string(),
            category: category.to_string(),
            via_gateway,
        };
        append_jsonl(&ev);
        g.ring.push_back(ev);
        while g.ring.len() > CAP {
            g.ring.pop_front();
        }
    }

    /// All retained events, oldest first.
    pub fn snapshot(&self) -> Vec<RouteEvent> {
        self.0.lock().unwrap().ring.iter().cloned().collect()
    }
}

/// Append one event as a JSON line to `activity.jsonl` beside the config. Best
/// effort: any IO error is swallowed so telemetry never disrupts a turn.
fn append_jsonl(ev: &RouteEvent) {
    let path = match crate::config::config_path().parent() {
        Some(dir) => dir.join("activity.jsonl"),
        None => return,
    };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        if let Ok(line) = serde_json::to_string(ev) {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// One model's routing count, for the summary.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelCount {
    pub model: String,
    pub count: u32,
}

/// Rolled-up activity: totals, the chat/gateway split, and per-model counts.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct Summary {
    pub total: u32,
    pub via_gateway: u32,
    pub via_chat: u32,
    pub per_model: Vec<ModelCount>,
}

/// Summarize events into counts. Per-model is sorted by count descending, then
/// model name for a stable order. Pure.
pub fn summarize(events: &[RouteEvent]) -> Summary {
    use std::collections::BTreeMap;
    let mut per: BTreeMap<String, u32> = BTreeMap::new();
    let mut via_gateway = 0u32;
    for e in events {
        *per.entry(e.model.clone()).or_insert(0) += 1;
        if e.via_gateway {
            via_gateway += 1;
        }
    }
    let mut per_model: Vec<ModelCount> =
        per.into_iter().map(|(model, count)| ModelCount { model, count }).collect();
    // BTreeMap gives name order; a stable sort by count desc keeps name order within ties.
    per_model.sort_by(|a, b| b.count.cmp(&a.count));
    let total = events.len() as u32;
    Summary { total, via_gateway, via_chat: total - via_gateway, per_model }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_orders_and_trims_to_cap() {
        let t = Telemetry::default();
        for i in 0..(CAP + 5) {
            t.record(&format!("m{}", i % 3), "chat", false);
        }
        let snap = t.snapshot();
        assert_eq!(snap.len(), CAP); // trimmed
        // Oldest retained has the lowest seq; seqs are strictly increasing.
        assert!(snap.first().unwrap().seq < snap.last().unwrap().seq);
        assert_eq!(snap.last().unwrap().seq, (CAP + 5) as u64);
    }

    #[test]
    fn summarize_counts_split_and_per_model() {
        let evs = vec![
            RouteEvent { seq: 1, model: "coder".into(), category: "coding".into(), via_gateway: true },
            RouteEvent { seq: 2, model: "coder".into(), category: "coding".into(), via_gateway: false },
            RouteEvent { seq: 3, model: "gen".into(), category: "chat".into(), via_gateway: true },
        ];
        let s = summarize(&evs);
        assert_eq!(s.total, 3);
        assert_eq!(s.via_gateway, 2);
        assert_eq!(s.via_chat, 1);
        assert_eq!(s.per_model[0], ModelCount { model: "coder".into(), count: 2 });
        assert_eq!(s.per_model[1], ModelCount { model: "gen".into(), count: 1 });
    }

    #[test]
    fn summarize_empty_is_zeroed() {
        let s = summarize(&[]);
        assert_eq!(s, Summary::default());
    }
}
