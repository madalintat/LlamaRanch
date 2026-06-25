// The fit math: given a model's shape and the machine, will it fit, how fast,
// and how to make it fit. Pure and std-only so every branch is unit-tested
// without a real GPU. The KV estimate uses q8_0 by default because that is the
// cache type the router actually runs (server.rs), and the estimate counts the
// vision mmproj that llama.cpp's own `--fit` ignores (and OOMs on).
use crate::gguf::GgufInfo;
use crate::hardware::{GpuKind, Hardware};

const MIB: u64 = 1024 * 1024;

/// KV-cache element width. `F16` is llama.cpp's default; `Q8_0` is what the
/// router actually runs (server.rs), halving KV memory at no measurable quality
/// cost. We surface both so the saving is legible rather than a black box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CacheType {
    F16,
    Q8_0,
}

impl CacheType {
    pub fn label(&self) -> &'static str {
        match self {
            CacheType::F16 => "f16",
            CacheType::Q8_0 => "q8_0",
        }
    }
}

/// Bytes of KV cache for one token at a given cache type. There are
/// `2 * n_layers * n_kv_heads * head_dim` cached scalars per token (K and V);
/// f16 spends 2 bytes each, q8_0 one.
pub fn kv_bytes_per_token(info: &GgufInfo, cache: CacheType) -> u64 {
    let scalars = 2 * info.n_layers as u64 * info.n_kv_heads as u64 * info.head_dim as u64;
    match cache {
        CacheType::F16 => scalars * 2,
        CacheType::Q8_0 => scalars,
    }
}

/// The memory-relevant shape of a model: weight bytes (the on-disk GGUF size is
/// a faithful proxy), the vision projector bytes (0 when not a vision model),
/// and KV bytes per token at the serving cache type.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelMem {
    pub weights: u64,
    pub mmproj: u64,
    pub kv_per_token: u64,
}

/// Fixed runtime overhead beyond weights and KV: compute buffers, the context
/// graph, and per-process accelerator state. A deliberately conservative flat
/// estimate; the context-dependent cost is already carried by the KV term.
pub fn overhead_bytes() -> u64 {
    600 * MIB
}

/// Total memory to run `m` at `ctx` tokens.
pub fn estimate_bytes(m: &ModelMem, ctx: u32) -> u64 {
    m.weights + m.mmproj + overhead_bytes() + m.kv_per_token * ctx as u64
}

/// How the model lands on this machine at the evaluated context.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Verdict {
    /// Comfortably on the accelerator.
    FitsFast,
    /// On the accelerator but close to the limit (unified memory pressure).
    Tight,
    /// Runs, but slowly: layers spill to CPU, or there is no accelerator.
    Slow,
    /// Exceeds memory at this context; will not run as configured.
    WontFit,
}

impl Verdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            Verdict::FitsFast => "fast",
            Verdict::Tight => "tight",
            Verdict::Slow => "slow",
            Verdict::WontFit => "wont_fit",
        }
    }
}

/// Classify a memory requirement against the machine. Apple Silicon shares one
/// pool, so the middle band is "tight" (still on the GPU, just close); a
/// discrete card offloads overflow to CPU RAM, so its middle band is "slow"; a
/// CPU-only box is "slow" until it runs out of RAM.
pub fn classify(needed: u64, hw: &Hardware) -> Verdict {
    let fast = hw.fast_budget();
    let ceiling = hw.usable_ceiling();
    match hw.gpu {
        GpuKind::AppleSilicon => {
            if needed <= fast {
                Verdict::FitsFast
            } else if needed <= ceiling {
                Verdict::Tight
            } else {
                Verdict::WontFit
            }
        }
        GpuKind::Nvidia { .. } => {
            if needed <= fast {
                Verdict::FitsFast
            } else if needed <= ceiling {
                Verdict::Slow
            } else {
                Verdict::WontFit
            }
        }
        GpuKind::Cpu => {
            if needed <= ceiling {
                Verdict::Slow
            } else {
                Verdict::WontFit
            }
        }
    }
}

/// Largest context (tokens) whose total estimate stays within `budget`, given
/// the fixed (non-KV) cost, rounded down to a 256-token step and capped at the
/// model's native training context. Zero when the fixed cost alone busts the
/// budget, or when no usable 256-token block fits.
pub fn max_ctx_for_budget(fixed_bytes: u64, kv_per_token: u64, budget: u64, native_ctx: u32) -> u32 {
    if kv_per_token == 0 {
        return native_ctx; // no per-token cost: native context is free re: KV
    }
    if fixed_bytes >= budget {
        return 0;
    }
    let avail = budget - fixed_bytes;
    let raw = (avail / kv_per_token).min(native_ctx as u64) as u32;
    (raw / 256) * 256
}

/// What to do about the fit: the biggest context that runs fast, the biggest
/// that runs at all, and whether the weights themselves are too big for this
/// machine (so only a smaller quant can help).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Recommendation {
    pub fast_ctx: u32,
    pub usable_ctx: u32,
    pub needs_smaller_quant: bool,
}

pub fn recommend(m: &ModelMem, native_ctx: u32, hw: &Hardware) -> Recommendation {
    let fixed = m.weights + m.mmproj + overhead_bytes();
    let fast_ctx = max_ctx_for_budget(fixed, m.kv_per_token, hw.fast_budget(), native_ctx);
    let usable_ctx = max_ctx_for_budget(fixed, m.kv_per_token, hw.usable_ceiling(), native_ctx);
    Recommendation {
        fast_ctx,
        usable_ctx,
        // Even an empty context will not fit: the weights are too big for this
        // box, and the only remedy is a smaller quantization of the model.
        needs_smaller_quant: usable_ctx == 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    fn info() -> GgufInfo {
        // 32 layers, 8 KV heads, head_dim 128: a Llama-3-8B-shaped model.
        GgufInfo { n_layers: 32, n_ctx_train: 8192, n_kv_heads: 8, head_dim: 128 }
    }

    #[test]
    fn kv_f16_matches_legacy() {
        // The f16 result must equal the original gguf helper (back-compat).
        let i = info();
        assert_eq!(kv_bytes_per_token(&i, CacheType::F16), crate::gguf::kv_bytes_per_token(&i));
    }

    #[test]
    fn kv_q8_is_half_of_f16() {
        let i = info();
        assert_eq!(
            kv_bytes_per_token(&i, CacheType::Q8_0) * 2,
            kv_bytes_per_token(&i, CacheType::F16)
        );
    }

    fn mem() -> ModelMem {
        ModelMem { weights: 5 * GIB, mmproj: 0, kv_per_token: 131_072 }
    }

    #[test]
    fn estimate_includes_all_terms() {
        let m = ModelMem { weights: 4 * GIB, mmproj: GIB, kv_per_token: 1000 };
        assert_eq!(estimate_bytes(&m, 2000), 4 * GIB + GIB + overhead_bytes() + 2_000_000);
    }

    #[test]
    fn estimate_scales_with_ctx() {
        let m = mem();
        let lo = estimate_bytes(&m, 1024);
        let hi = estimate_bytes(&m, 8192);
        assert_eq!(hi - lo, m.kv_per_token * (8192 - 1024));
    }

    #[test]
    fn estimate_zero_ctx_is_fixed_cost() {
        let m = mem();
        assert_eq!(estimate_bytes(&m, 0), m.weights + m.mmproj + overhead_bytes());
    }

    fn apple(ram: u64) -> Hardware {
        Hardware { total_ram: ram, gpu: GpuKind::AppleSilicon }
    }
    fn nvidia(ram: u64, vram: u64) -> Hardware {
        Hardware { total_ram: ram, gpu: GpuKind::Nvidia { vram } }
    }
    fn cpu(ram: u64) -> Hardware {
        Hardware { total_ram: ram, gpu: GpuKind::Cpu }
    }

    #[test]
    fn classify_apple_silicon_bands() {
        let hw = apple(64 * GIB); // fast = 44.8 GiB, ceiling = 57.6 GiB
        assert_eq!(classify(10 * GIB, &hw), Verdict::FitsFast);
        assert_eq!(classify(50 * GIB, &hw), Verdict::Tight);
        assert_eq!(classify(60 * GIB, &hw), Verdict::WontFit);
    }

    #[test]
    fn classify_nvidia_bands() {
        let hw = nvidia(64 * GIB, 12 * GIB); // fast ~= 11.5 GiB, ceiling = 64 GiB
        assert_eq!(classify(10 * GIB, &hw), Verdict::FitsFast);
        assert_eq!(classify(40 * GIB, &hw), Verdict::Slow);
        assert_eq!(classify(100 * GIB, &hw), Verdict::WontFit);
    }

    #[test]
    fn classify_cpu_bands() {
        let hw = cpu(16 * GIB); // ceiling = 14.4 GiB, no fast path
        assert_eq!(classify(10 * GIB, &hw), Verdict::Slow);
        assert_eq!(classify(15 * GIB, &hw), Verdict::WontFit);
    }

    #[test]
    fn max_ctx_solves_and_rounds() {
        // budget leaves room for 5000 tokens of KV; rounds down to 4864 (19*256).
        let fixed = 4 * GIB;
        let kv = 100_000u64;
        let budget = fixed + 500_000_000; // 5000 tokens exactly
        assert_eq!(max_ctx_for_budget(fixed, kv, budget, 8192), 4864);
    }

    #[test]
    fn max_ctx_caps_at_native() {
        // Huge budget, tiny KV: capped at native, still 256-aligned.
        assert_eq!(max_ctx_for_budget(0, 1, 1_000_000_000, 8192), 8192);
    }

    #[test]
    fn max_ctx_zero_when_fixed_exceeds_budget() {
        assert_eq!(max_ctx_for_budget(10 * GIB, 100_000, 8 * GIB, 8192), 0);
    }

    #[test]
    fn recommend_fast_never_exceeds_usable() {
        let m = mem();
        let r = recommend(&m, 8192, &apple(64 * GIB));
        assert!(r.fast_ctx <= r.usable_ctx);
        assert!(!r.needs_smaller_quant);
    }

    #[test]
    fn recommend_flags_smaller_quant_when_weights_bust_machine() {
        // 30 GiB of weights on a 16 GiB Mac: even empty context will not fit.
        let m = ModelMem { weights: 30 * GIB, mmproj: 0, kv_per_token: 131_072 };
        let r = recommend(&m, 8192, &apple(16 * GIB));
        assert_eq!(r.usable_ctx, 0);
        assert!(r.needs_smaller_quant);
    }
}
