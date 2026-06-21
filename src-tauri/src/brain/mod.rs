//! The harness brain: routes each chat turn to the best local expert model.
pub mod resolver;

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
