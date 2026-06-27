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

/// One tool run, with its privacy scope. The only actions that can leave the
/// machine are online tools, so these are what the Ledger watches.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolEvent {
    pub seq: u64,
    pub name: String,
    pub scope: String, // "local" | "online"
    pub ok: bool,
}

#[derive(Default)]
struct Inner {
    seq: u64,
    ring: VecDeque<RouteEvent>,
    tool_ring: VecDeque<ToolEvent>,
    /// Monotonic action counts (never trimmed), so the ledger's "stayed local"
    /// proof can never flip back to true after the rings evict an online event.
    local_total: u32,
    online_total: u32,
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
        // Build and store under the lock, then write the log line after releasing
        // it, so a slow disk never stalls routing or the Activity snapshot.
        let ev = {
            let mut g = self.0.lock().unwrap();
            g.seq += 1;
            g.local_total = g.local_total.saturating_add(1); // every inference is local
            let ev = RouteEvent {
                seq: g.seq,
                model: model.to_string(),
                category: category.to_string(),
                via_gateway,
            };
            g.ring.push_back(ev.clone());
            while g.ring.len() > CAP {
                g.ring.pop_front();
            }
            ev
        };
        append_jsonl(&ev);
    }

    /// All retained events, oldest first.
    pub fn snapshot(&self) -> Vec<RouteEvent> {
        self.0.lock().unwrap().ring.iter().cloned().collect()
    }

    /// Record one tool run with its privacy scope. Best-effort, like `record`.
    pub fn record_tool(&self, name: &str, scope: &str, ok: bool) {
        let ev = {
            let mut g = self.0.lock().unwrap();
            g.seq += 1;
            if scope == "online" {
                g.online_total = g.online_total.saturating_add(1);
            } else {
                g.local_total = g.local_total.saturating_add(1);
            }
            let ev = ToolEvent { seq: g.seq, name: name.to_string(), scope: scope.to_string(), ok };
            g.tool_ring.push_back(ev.clone());
            while g.tool_ring.len() > CAP {
                g.tool_ring.pop_front();
            }
            ev
        };
        append_tool_jsonl(&ev);
    }

    /// The proof-of-local ledger: monotonic action totals plus the most recent
    /// online actions (newest first) still retained in the ring.
    pub fn ledger(&self) -> Ledger {
        let g = self.0.lock().unwrap();
        let recent_online: Vec<ToolEvent> = g
            .tool_ring
            .iter()
            .rev()
            .filter(|t| t.scope == "online")
            .take(10)
            .cloned()
            .collect();
        build_ledger(g.local_total, g.online_total, recent_online)
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

/// Append one tool event as a JSON line to `valley.jsonl` beside the config.
/// Best effort: any IO error is swallowed so telemetry never disrupts a turn.
fn append_tool_jsonl(ev: &ToolEvent) {
    let path = match crate::config::config_path().parent() {
        Some(dir) => dir.join("valley.jsonl"),
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

/// The proof-of-local ledger: how many actions stayed home, how many reached the
/// internet (only online tools can), and whether nothing left the valley at all.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct Ledger {
    pub local_actions: u32,
    pub online_actions: u32,
    pub stayed_local: bool,
    pub recent_online: Vec<ToolEvent>,
}

/// Build the ledger from monotonic action totals and the recent online events.
/// Every inference is local (the router is loopback); only online tools can leave
/// the valley. The totals come from never-trimmed counters, so "stayed local" is
/// honest even after the rings evict old events. Pure.
pub fn build_ledger(local_total: u32, online_total: u32, recent_online: Vec<ToolEvent>) -> Ledger {
    Ledger {
        local_actions: local_total,
        online_actions: online_total,
        stayed_local: online_total == 0,
        recent_online,
    }
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

    fn tool(seq: u64, name: &str, scope: &str) -> ToolEvent {
        ToolEvent { seq, name: name.into(), scope: scope.into(), ok: true }
    }

    #[test]
    fn build_ledger_stays_local_with_no_online() {
        let l = build_ledger(2, 0, vec![]);
        assert_eq!(l.local_actions, 2);
        assert_eq!(l.online_actions, 0);
        assert!(l.stayed_local);
        assert!(l.recent_online.is_empty());
    }

    #[test]
    fn build_ledger_flags_online_newest_first() {
        let l = build_ledger(
            1,
            2,
            vec![tool(3, "web_search", "online"), tool(1, "web_fetch", "online")],
        );
        assert_eq!(l.online_actions, 2);
        assert!(!l.stayed_local);
        assert_eq!(l.local_actions, 1);
        assert_eq!(l.recent_online[0].name, "web_search");
    }

    #[test]
    fn ledger_counts_routes_and_tools_as_local() {
        let t = Telemetry::default();
        t.record("g", "chat", false); // one local inference
        t.record_tool("read_file", "local", true); // one local tool
        let l = t.ledger();
        assert_eq!(l.local_actions, 2);
        assert!(l.stayed_local);
    }

    #[test]
    fn ledger_online_total_survives_ring_eviction() {
        let t = Telemetry::default();
        t.record_tool("web_fetch", "online", true); // one online action
        for _ in 0..(CAP + 5) {
            t.record_tool("read_file", "local", true); // floods + evicts the online event from the ring
        }
        let l = t.ledger();
        assert_eq!(l.online_actions, 1); // counted from the monotonic total, not the ring
        assert!(!l.stayed_local); // the proof stays honest
        assert_eq!(l.recent_online.len(), 0); // ring no longer holds it; the total still does
    }

    #[test]
    fn ledger_local_total_not_trimmed_by_ring() {
        let t = Telemetry::default();
        for i in 0..(CAP + 3) {
            t.record_tool(&format!("t{i}"), "local", true);
        }
        assert_eq!(t.ledger().local_actions, (CAP + 3) as u32);
    }
}
