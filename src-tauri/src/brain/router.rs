use super::{Category, Classifier, EmbeddingGate, RouteDecision, Router, TurnContext};

/// Confidence below which the embedding gate defers to the classifier.
const GATE_THRESHOLD: f32 = 0.75;

pub struct DefaultRouter<G: EmbeddingGate, C: Classifier> {
    pub gate: G,
    pub classifier: C,
}

impl<G: EmbeddingGate, C: Classifier> Router for DefaultRouter<G, C> {
    fn route(&self, ctx: &TurnContext) -> RouteDecision {
        // 1) explicit user pick wins
        if let Some(group) = &ctx.explicit_group {
            let category = match group.as_str() {
                "coding" => Category::Code,
                "reasoning" => Category::Reasoning,
                "vision" => Category::Vision,
                _ => Category::General,
            };
            return RouteDecision { category, reason: "you picked this model".into() };
        }
        // 2) image attachment → vision
        if ctx.has_image {
            return RouteDecision { category: Category::Vision, reason: "image attached".into() };
        }
        // 3) explicit /code prefix
        if ctx.text.trim_start().starts_with("/code") {
            return RouteDecision { category: Category::Code, reason: "/code hint".into() };
        }
        // 4) embedding gate
        if let Some((cat, conf)) = self.gate.category(&ctx.text) {
            if conf >= GATE_THRESHOLD {
                return RouteDecision { category: cat, reason: format!("matched {} (conf {:.2})", cat.group(), conf) };
            }
        }
        // 5) classifier fallback
        let cat = self.classifier.classify(&ctx.text);
        RouteDecision { category: cat, reason: format!("classified as {}", cat.group()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StubGate(Option<(Category, f32)>);
    impl EmbeddingGate for StubGate {
        fn category(&self, _t: &str) -> Option<(Category, f32)> { self.0 }
    }
    struct StubClassifier(Category);
    impl Classifier for StubClassifier {
        fn classify(&self, _t: &str) -> Category { self.0 }
    }
    fn router(gate: Option<(Category, f32)>, fallback: Category) -> DefaultRouter<StubGate, StubClassifier> {
        DefaultRouter { gate: StubGate(gate), classifier: StubClassifier(fallback) }
    }
    fn ctx(text: &str, has_image: bool, explicit: Option<&str>) -> TurnContext {
        TurnContext { text: text.into(), has_image, explicit_group: explicit.map(|s| s.into()) }
    }

    #[test]
    fn explicit_pick_wins() {
        let r = router(Some((Category::General, 0.99)), Category::General);
        assert_eq!(r.route(&ctx("hi", true, Some("coding"))).category, Category::Code);
    }
    #[test]
    fn image_routes_vision() {
        let r = router(None, Category::General);
        assert_eq!(r.route(&ctx("what is this", true, None)).category, Category::Vision);
    }
    #[test]
    fn code_prefix_routes_code() {
        let r = router(None, Category::General);
        assert_eq!(r.route(&ctx("/code fix this", false, None)).category, Category::Code);
    }
    #[test]
    fn confident_gate_routes_directly() {
        let r = router(Some((Category::Reasoning, 0.9)), Category::General);
        assert_eq!(r.route(&ctx("prove that...", false, None)).category, Category::Reasoning);
    }
    #[test]
    fn low_confidence_gate_defers_to_classifier() {
        let r = router(Some((Category::Reasoning, 0.5)), Category::Code);
        assert_eq!(r.route(&ctx("ambiguous", false, None)).category, Category::Code);
    }
    #[test]
    fn no_gate_uses_classifier() {
        let r = router(None, Category::General);
        assert_eq!(r.route(&ctx("hello", false, None)).category, Category::General);
    }
}
