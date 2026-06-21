// Curated, hardware-appropriate models that can be downloaded from Hugging Face.
// Each downloads to <models_dir>/<group>/<file>, picked up by the scanner.

pub struct CatalogEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub group: &'static str,
    pub repo: &'static str,
    pub file: &'static str,
    /// For vision models: the mmproj file in the same repo (downloaded alongside).
    pub mmproj: Option<&'static str>,
    pub approx_gb: f64,
}

pub fn catalog() -> &'static [CatalogEntry] {
    &[
        // ---- chat ----
        CatalogEntry { id: "qwen3-0.6b", name: "Qwen3 0.6B", description: "Ultra-tiny chat model — instant, runs anywhere, fully on GPU.", group: "chat", repo: "unsloth/Qwen3-0.6B-GGUF", file: "Qwen3-0.6B-Q4_K_M.gguf", mmproj: None, approx_gb: 0.5 },
        CatalogEntry { id: "qwen3-1.7b", name: "Qwen3 1.7B", description: "Tiny, fast chat model — instant responses, fully on GPU.", group: "chat", repo: "unsloth/Qwen3-1.7B-GGUF", file: "Qwen3-1.7B-Q4_K_M.gguf", mmproj: None, approx_gb: 1.1 },
        CatalogEntry { id: "qwen3-4b", name: "Qwen3 4B", description: "Capable small chat model, strong for its size, fits on GPU.", group: "chat", repo: "unsloth/Qwen3-4B-GGUF", file: "Qwen3-4B-Q4_K_M.gguf", mmproj: None, approx_gb: 2.5 },
        CatalogEntry { id: "qwen3-8b", name: "Qwen3 8B", description: "Mid-size Qwen3 — strong general chat, partial GPU offload.", group: "chat", repo: "unsloth/Qwen3-8B-GGUF", file: "Qwen3-8B-Q4_K_M.gguf", mmproj: None, approx_gb: 5.0 },
        CatalogEntry { id: "llama-3.2-1b", name: "Llama 3.2 1B Instruct", description: "Meta's smallest instruct model — very fast, fully on GPU.", group: "chat", repo: "bartowski/Llama-3.2-1B-Instruct-GGUF", file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", mmproj: None, approx_gb: 0.8 },
        CatalogEntry { id: "llama-3.2-3b", name: "Llama 3.2 3B Instruct", description: "Meta's compact instruct model, great all-rounder on GPU.", group: "chat", repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf", mmproj: None, approx_gb: 2.0 },
        CatalogEntry { id: "llama-3.1-8b", name: "Llama 3.1 8B Instruct", description: "Meta's classic 8B all-rounder, partial GPU offload.", group: "chat", repo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF", file: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf", mmproj: None, approx_gb: 4.9 },
        CatalogEntry { id: "gemma-3-1b", name: "Gemma 3 1B", description: "Google's tiny instruct model — quick replies, fully on GPU.", group: "chat", repo: "ggml-org/gemma-3-1b-it-GGUF", file: "gemma-3-1b-it-Q4_K_M.gguf", mmproj: None, approx_gb: 0.8 },
        CatalogEntry { id: "gemma-3-12b", name: "Gemma 3 12B", description: "Google's larger open model — partial GPU offload, slower.", group: "chat", repo: "ggml-org/gemma-3-12b-it-GGUF", file: "gemma-3-12b-it-Q4_K_M.gguf", mmproj: None, approx_gb: 7.3 },
        CatalogEntry { id: "mistral-7b-v0.3", name: "Mistral 7B Instruct v0.3", description: "Mistral's solid 7B all-rounder, partial GPU offload.", group: "chat", repo: "bartowski/Mistral-7B-Instruct-v0.3-GGUF", file: "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf", mmproj: None, approx_gb: 4.4 },
        CatalogEntry { id: "phi-4-mini", name: "Phi-4 Mini", description: "Microsoft's small, reasoning-leaning instruct model, on GPU.", group: "chat", repo: "bartowski/microsoft_Phi-4-mini-instruct-GGUF", file: "microsoft_Phi-4-mini-instruct-Q4_K_M.gguf", mmproj: None, approx_gb: 2.5 },
        CatalogEntry { id: "smollm2-1.7b", name: "SmolLM2 1.7B", description: "Hugging Face's efficient tiny chat model, fully on GPU.", group: "chat", repo: "bartowski/SmolLM2-1.7B-Instruct-GGUF", file: "SmolLM2-1.7B-Instruct-Q4_K_M.gguf", mmproj: None, approx_gb: 1.1 },
        CatalogEntry { id: "smollm2-360m", name: "SmolLM2 360M", description: "Ultra-tiny chat model — instant responses, runs fully on any GPU.", group: "chat", repo: "bartowski/SmolLM2-360M-Instruct-GGUF", file: "SmolLM2-360M-Instruct-Q4_K_M.gguf", mmproj: None, approx_gb: 0.3 },
        CatalogEntry { id: "phi-3.5-mini", name: "Phi-3.5 Mini Instruct", description: "Microsoft's compact reasoning-focused instruct model, fits on GPU.", group: "chat", repo: "bartowski/Phi-3.5-mini-instruct-GGUF", file: "Phi-3.5-mini-instruct-Q4_K_M.gguf", mmproj: None, approx_gb: 2.4 },
        CatalogEntry { id: "qwen2.5-7b", name: "Qwen2.5 7B Instruct", description: "Alibaba's capable 7B chat model — strong multilingual, partial GPU offload.", group: "chat", repo: "bartowski/Qwen2.5-7B-Instruct-GGUF", file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf", mmproj: None, approx_gb: 4.7 },
        // ---- reasoning ----
        CatalogEntry { id: "deepseek-r1-qwen-1.5b", name: "DeepSeek-R1 Distill Qwen 1.5B", description: "Tiny reasoning model that shows its thinking, fully on GPU.", group: "reasoning", repo: "bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF", file: "DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf", mmproj: None, approx_gb: 1.1 },
        CatalogEntry { id: "deepseek-r1-qwen-7b", name: "DeepSeek-R1 Distill Qwen 7B", description: "Strong step-by-step reasoning, partial GPU offload.", group: "reasoning", repo: "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF", file: "DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf", mmproj: None, approx_gb: 4.7 },
        CatalogEntry { id: "deepseek-r1-llama-8b", name: "DeepSeek-R1 Distill Llama 8B", description: "Llama-based reasoning distill — strong chain-of-thought, partial GPU offload.", group: "reasoning", repo: "bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF", file: "DeepSeek-R1-Distill-Llama-8B-Q4_K_M.gguf", mmproj: None, approx_gb: 4.9 },
        // ---- coding ----
        CatalogEntry { id: "qwen2.5-coder-1.5b", name: "Qwen2.5 Coder 1.5B", description: "Tiny coding model — autocomplete and quick edits, on GPU.", group: "coding", repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF", file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf", mmproj: None, approx_gb: 1.0 },
        CatalogEntry { id: "qwen2.5-coder-3b", name: "Qwen2.5 Coder 3B", description: "Lightweight coding model, fits fully on the GPU.", group: "coding", repo: "Qwen/Qwen2.5-Coder-3B-Instruct-GGUF", file: "qwen2.5-coder-3b-instruct-q4_k_m.gguf", mmproj: None, approx_gb: 1.9 },
        CatalogEntry { id: "qwen2.5-coder-7b", name: "Qwen2.5 Coder 7B", description: "Capable coding model, partial GPU offload.", group: "coding", repo: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF", file: "qwen2.5-coder-7b-instruct-q4_k_m.gguf", mmproj: None, approx_gb: 4.7 },
        // ---- vision ----
        CatalogEntry { id: "gemma-3-4b-vision", name: "Gemma 3 4B (vision)", description: "Google multimodal model — chat about images, fits on GPU.", group: "vision", repo: "ggml-org/gemma-3-4b-it-GGUF", file: "gemma-3-4b-it-Q4_K_M.gguf", mmproj: Some("mmproj-model-f16.gguf"), approx_gb: 3.4 },
        CatalogEntry { id: "qwen2.5-vl-3b", name: "Qwen2.5-VL 3B (vision)", description: "Alibaba vision-language model — image understanding on GPU.", group: "vision", repo: "ggml-org/Qwen2.5-VL-3B-Instruct-GGUF", file: "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf", mmproj: Some("mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf"), approx_gb: 2.3 },
        CatalogEntry { id: "qwen2.5-vl-7b", name: "Qwen2.5-VL 7B (vision)", description: "Larger vision-language model, partial GPU offload.", group: "vision", repo: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF", file: "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf", mmproj: Some("mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf"), approx_gb: 5.0 },
        // ---- embedding ----
        CatalogEntry { id: "qwen3-embed-0.6b", name: "Qwen3 Embedding 0.6B", description: "Text embeddings for search and RAG.", group: "embedding", repo: "Qwen/Qwen3-Embedding-0.6B-GGUF", file: "Qwen3-Embedding-0.6B-f16.gguf", mmproj: None, approx_gb: 1.2 },
        CatalogEntry { id: "nomic-embed-1.5", name: "Nomic Embed Text v1.5", description: "Long-context text embeddings for RAG — tiny, fully on GPU.", group: "embedding", repo: "nomic-ai/nomic-embed-text-v1.5-GGUF", file: "nomic-embed-text-v1.5.Q4_K_M.gguf", mmproj: None, approx_gb: 0.1 },
    ]
}

pub fn find(id: &str) -> Option<&'static CatalogEntry> {
    catalog().iter().find(|e| e.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_integrity() {
        let allowed = ["chat", "reasoning", "coding", "vision", "embedding"];
        let mut ids = HashSet::new();
        for e in catalog() {
            assert!(ids.insert(e.id), "duplicate id: {}", e.id);
            assert!(!e.id.is_empty(), "empty id");
            assert!(!e.name.is_empty(), "empty name: {}", e.id);
            assert!(!e.description.is_empty(), "empty description: {}", e.id);
            assert!(!e.repo.is_empty() && !e.file.is_empty(), "empty repo/file: {}", e.id);
            assert!(e.approx_gb > 0.0, "approx_gb must be > 0: {}", e.id);
            assert!(allowed.contains(&e.group), "bad group '{}': {}", e.group, e.id);
            if e.mmproj.is_some() {
                assert_eq!(e.group, "vision", "mmproj only on vision: {}", e.id);
            }
        }
        assert!(catalog().len() >= 7);
    }
}
