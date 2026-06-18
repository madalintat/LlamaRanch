// Curated, hardware-appropriate models that can be downloaded from Hugging Face.
// Each downloads to <models_dir>/<group>/<file>, picked up by the scanner.

pub struct CatalogEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub group: &'static str,
    pub repo: &'static str,
    pub file: &'static str,
    pub approx_gb: f64,
}

pub fn catalog() -> &'static [CatalogEntry] {
    &[
        CatalogEntry {
            id: "qwen3-1.7b",
            name: "Qwen3 1.7B",
            description: "Tiny, fast chat model - instant responses, fully on GPU.",
            group: "chat",
            repo: "unsloth/Qwen3-1.7B-GGUF",
            file: "Qwen3-1.7B-Q4_K_M.gguf",
            approx_gb: 1.1,
        },
        CatalogEntry {
            id: "llama-3.2-3b",
            name: "Llama 3.2 3B Instruct",
            description: "Meta's compact instruct model, great all-rounder on GPU.",
            group: "chat",
            repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
            file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
            approx_gb: 2.0,
        },
        CatalogEntry {
            id: "qwen2.5-coder-3b",
            name: "Qwen2.5 Coder 3B",
            description: "Lightweight coding model, fits fully on the GPU.",
            group: "coding",
            repo: "Qwen/Qwen2.5-Coder-3B-Instruct-GGUF",
            file: "qwen2.5-coder-3b-instruct-q4_k_m.gguf",
            approx_gb: 1.9,
        },
        CatalogEntry {
            id: "qwen3-embed-0.6b",
            name: "Qwen3 Embedding 0.6B",
            description: "Text embeddings for search and RAG.",
            group: "embedding",
            repo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
            file: "Qwen3-Embedding-0.6B-f16.gguf",
            approx_gb: 1.2,
        },
        CatalogEntry {
            id: "gemma-4-12b",
            name: "Gemma 4 12B",
            description: "Google's capable open model - partial GPU offload, slower.",
            group: "chat",
            repo: "ggml-org/gemma-4-12B-it-GGUF",
            file: "gemma-4-12B-it-Q4_K_M.gguf",
            approx_gb: 7.0,
        },
    ]
}

pub fn find(id: &str) -> Option<&'static CatalogEntry> {
    catalog().iter().find(|e| e.id == id)
}
