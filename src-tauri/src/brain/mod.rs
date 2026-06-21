//! The harness brain: routes each chat turn to the best local expert model.
pub mod backend;
pub mod resolver;
pub mod router;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    General,
    Code,
    Reasoning,
    Vision,
}

impl Category {
    /// Catalog group string this category maps to.
    pub fn group(self) -> &'static str {
        match self {
            Category::General => "chat",
            Category::Code => "coding",
            Category::Reasoning => "reasoning",
            Category::Vision => "vision",
        }
    }
}

/// A chat message in the conversation history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

/// Minimal model facts the resolver needs (derived from the scanner/router list).
#[derive(Clone, Debug, PartialEq)]
pub struct ModelLite {
    pub id: String,
    pub group: String, // "chat" | "coding" | "reasoning" | "vision" | ...
}

#[derive(Clone, Debug, PartialEq)]
pub struct RouteDecision {
    pub category: Category,
    pub reason: String,
}

/// Everything known about an incoming turn before routing.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnContext {
    pub text: String,
    pub has_image: bool,
    pub explicit_group: Option<String>, // user pinned a model → its catalog group
}

/// Fast embedding-similarity gate. Returns a category + confidence, or None to defer.
pub trait EmbeddingGate {
    fn category(&self, text: &str) -> Option<(Category, f32)>;
}

/// Tiny-model fallback classifier for ambiguous text.
pub trait Classifier {
    fn classify(&self, text: &str) -> Category;
}

/// Decides the category for a turn.
pub trait Router {
    fn route(&self, ctx: &TurnContext) -> RouteDecision;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

/// Streams a completion from a model. Synchronous (ureq); calls `on_token` per chunk.
pub trait ChatBackend {
    fn stream(
        &self,
        model_id: &str,
        messages: &[Message],
        on_token: &mut dyn FnMut(String),
    ) -> Result<Usage, String>;
}

/// Ensures a model is loaded and ready before inference.
pub trait Lifecycle {
    fn ensure_loaded(&self, model_id: &str) -> Result<(), String>;
}
