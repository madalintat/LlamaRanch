//! Routing-aware model-pool lifecycle: pin the general model, hot-swap experts,
//! evict the least-recently-used expert when at capacity.
use std::sync::Mutex;

/// Decide which resident expert ids to unload before loading `target`, so the
/// number of resident (non-pinned) experts stays within `capacity`. Pure.
///
/// - `resident`: ids currently resident (loaded/sleeping), may include pinned.
/// - `pinned`: ids that must never be evicted.
/// - `capacity`: max resident non-pinned experts allowed (>=1).
/// - `lru_order`: most-recently-used first.
///
/// Returns coldest-first ids to unload; empty if `target` is already resident
/// or there is room.
pub fn plan_eviction(
    target: &str,
    resident: &[String],
    pinned: &[String],
    capacity: usize,
    lru_order: &[String],
) -> Vec<String> {
    if resident.iter().any(|r| r == target) {
        return Vec::new();
    }
    let cap = capacity.max(1);
    let candidates: Vec<&String> = resident
        .iter()
        .filter(|r| !pinned.iter().any(|p| p == *r) && r.as_str() != target)
        .collect();
    // After loading target: candidates.len() + 1 resident experts.
    let over = (candidates.len() + 1).saturating_sub(cap);
    if over == 0 {
        return Vec::new();
    }
    // Coldest first: lower priority = larger index in lru_order; absent = coldest.
    let rank = |id: &String| lru_order.iter().position(|x| x == id).unwrap_or(usize::MAX);
    let mut sorted = candidates;
    sorted.sort_by_key(|id| std::cmp::Reverse(rank(id)));
    sorted.into_iter().take(over).cloned().collect()
}

/// In-memory most-recently-used order of selected model ids (front = newest).
#[derive(Default)]
pub struct Pool(pub Mutex<Vec<String>>);

impl Pool {
    pub fn touch(&self, id: &str) {
        let mut v = self.0.lock().unwrap();
        v.retain(|x| x != id);
        v.insert(0, id.to_string());
    }
    pub fn order(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

use crate::brain::Lifecycle;
use crate::commands::AppConfig;
use crate::server;
use serde::Serialize;
use tauri::State;

fn resident_ids(port: u16) -> Vec<String> {
    server::list_models(port)
        .into_iter()
        .filter(|m| m.status == "loaded" || m.status == "sleeping")
        .map(|m| m.id)
        .collect()
}

/// Routing-aware Lifecycle: evict the LRU non-pinned expert when at capacity,
/// then load the target and mark it most-recently-used.
pub struct PoolLifecycle<'a> {
    pub port: u16,
    pub pinned: Vec<String>,
    pub capacity: usize,
    pub pool: &'a Pool,
}

impl Lifecycle for PoolLifecycle<'_> {
    fn ensure_loaded(&self, target: &str) -> Result<(), String> {
        let resident = resident_ids(self.port);
        for id in plan_eviction(target, &resident, &self.pinned, self.capacity, &self.pool.order()) {
            let _ = server::unload(self.port, &id); // best-effort
        }
        server::load(self.port, target)?;
        self.pool.touch(target);
        Ok(())
    }
}

#[derive(Serialize)]
pub struct PoolEntry {
    pub id: String,
    pub status: String,
    pub pinned: bool,
}

#[derive(Serialize)]
pub struct PoolView {
    pub resident: Vec<PoolEntry>,
    pub active: Option<String>,
}

#[tauri::command]
pub fn model_pool(cfg: State<AppConfig>, pool: State<Pool>) -> PoolView {
    let (port, general) = {
        let c = cfg.0.lock().unwrap();
        (c.port, c.general_model.clone())
    };
    let resident = server::list_models(port)
        .into_iter()
        .filter(|m| m.status == "loaded" || m.status == "sleeping")
        .map(|m| PoolEntry { pinned: m.id == general, id: m.id, status: m.status })
        .collect();
    let active = pool.order().into_iter().next();
    PoolView { resident, active }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn v(xs: &[&str]) -> Vec<String> { xs.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn target_already_resident_no_eviction() {
        assert_eq!(plan_eviction("a", &v(&["a", "b"]), &v(&[]), 1, &v(&["a", "b"])), Vec::<String>::new());
    }
    #[test]
    fn room_available_no_eviction() {
        assert_eq!(plan_eviction("c", &v(&["a"]), &v(&[]), 3, &v(&["a"])), Vec::<String>::new());
    }
    #[test]
    fn at_capacity_evicts_lru_expert() {
        // capacity 1, one resident expert "a"; loading "b" → evict "a"
        assert_eq!(plan_eviction("b", &v(&["a"]), &v(&[]), 1, &v(&["a"])), v(&["a"]));
    }
    #[test]
    fn never_evicts_pinned() {
        // general is pinned + coldest, but must not be evicted; "a" goes instead
        let got = plan_eviction("r", &v(&["general", "a"]), &v(&["general"]), 1, &v(&["a", "general"]));
        assert_eq!(got, v(&["a"]));
    }
    #[test]
    fn evicts_multiple_coldest_first() {
        // capacity 1, residents a,b; lru front=b (newest), a colder → evict a then b
        let got = plan_eviction("c", &v(&["a", "b"]), &v(&[]), 1, &v(&["b", "a"]));
        assert_eq!(got, v(&["a", "b"]));
    }
    #[test]
    fn pool_touch_moves_to_front() {
        let p = Pool::default();
        p.touch("a"); p.touch("b"); p.touch("a");
        assert_eq!(p.order(), v(&["a", "b"]));
    }
}
