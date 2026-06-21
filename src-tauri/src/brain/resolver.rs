use super::{Category, ModelLite};

/// Picks a concrete model id for a category. Pure over the model lists.
pub trait Resolver {
    fn resolve(&self, category: Category, installed: &[ModelLite], loaded: &[String]) -> Option<String>;
}

pub struct DefaultResolver;

impl Resolver for DefaultResolver {
    fn resolve(&self, category: Category, installed: &[ModelLite], loaded: &[String]) -> Option<String> {
        let group = category.group();
        // 1) prefer an already-loaded model of the right group
        if let Some(m) = installed
            .iter()
            .find(|m| m.group == group && loaded.contains(&m.id))
        {
            return Some(m.id.clone());
        }
        // 2) else the first installed model of the group
        if let Some(m) = installed.iter().find(|m| m.group == group) {
            return Some(m.id.clone());
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models() -> Vec<ModelLite> {
        vec![
            ModelLite { id: "qwen3-8b".into(), group: "chat".into() },
            ModelLite { id: "qwen2.5-coder-7b".into(), group: "coding".into() },
            ModelLite { id: "coder-loaded".into(), group: "coding".into() },
        ]
    }

    #[test]
    fn prefers_loaded_model_of_group() {
        let r = DefaultResolver;
        let got = r.resolve(Category::Code, &models(), &["coder-loaded".into()]);
        assert_eq!(got.as_deref(), Some("coder-loaded"));
    }

    #[test]
    fn falls_back_to_first_installed_of_group() {
        let r = DefaultResolver;
        let got = r.resolve(Category::Code, &models(), &[]);
        assert_eq!(got.as_deref(), Some("qwen2.5-coder-7b"));
    }

    #[test]
    fn none_when_no_model_of_group() {
        let r = DefaultResolver;
        assert_eq!(r.resolve(Category::Vision, &models(), &[]), None);
    }
}
