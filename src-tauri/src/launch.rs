const GB: u64 = 1_000_000_000;

/// Rough hint of where a model will run on this machine, shown as a badge.
/// The router's `--fit` makes the real GPU-layer/context decision at load time;
/// even large models still offload some layers to the GPU, hence "Hybrid"
/// rather than "CPU".
pub fn placement_for(size_bytes: u64) -> &'static str {
    if size_bytes <= 3 * GB {
        "GPU"
    } else if size_bytes <= 6 * GB {
        "Partial"
    } else {
        "Hybrid"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placement_buckets() {
        assert_eq!(placement_for(2 * GB), "GPU");
        assert_eq!(placement_for(5 * GB), "Partial");
        assert_eq!(placement_for(18 * GB), "Hybrid");
    }
}
