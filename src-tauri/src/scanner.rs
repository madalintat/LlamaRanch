use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub group: String,
    pub path: String,
    pub size_bytes: u64,
    pub mmproj_path: Option<String>,
}

fn collect_gguf(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_gguf(&p, out);
            } else if p.extension().and_then(|s| s.to_str()) == Some("gguf") {
                out.push(p);
            }
        }
    }
}

fn is_mmproj(p: &Path) -> bool {
    p.file_name()
        .and_then(|s| s.to_str())
        .map(|n| n.starts_with("mmproj"))
        .unwrap_or(false)
}

pub fn scan(root: &Path) -> Vec<Model> {
    let mut files = Vec::new();
    collect_gguf(root, &mut files);

    let mmprojs: Vec<&PathBuf> = files.iter().filter(|p| is_mmproj(p)).collect();

    files
        .iter()
        .filter(|p| !is_mmproj(p))
        .map(|p| {
            let id = p.file_stem().unwrap().to_string_lossy().to_string();
            let group = p
                .parent()
                .and_then(|d| d.file_name())
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "models".into());
            let size_bytes = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            let mmproj_path = mmprojs
                .iter()
                .find(|mm| mm.parent() == p.parent())
                .map(|mm| mm.to_string_lossy().to_string());
            Model {
                id: id.clone(),
                name: id,
                group,
                path: p.to_string_lossy().to_string(),
                size_bytes,
                mmproj_path,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(p: &Path, bytes: usize) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn scans_grouped_models_and_pairs_mmproj() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("chat/Qwen3-4B-Q4_K_M.gguf"), 10);
        touch(&root.join("vision/MiniCPM-V-4.6-Q4_K_M.gguf"), 20);
        touch(&root.join("vision/mmproj-MiniCPM-V-4.6-Q8_0.gguf"), 5);
        touch(&root.join("vision/notes.txt"), 3);

        let mut models = scan(root);
        models.sort_by(|a, b| a.id.cmp(&b.id));

        assert_eq!(models.len(), 2);
        let chat = models.iter().find(|m| m.group == "chat").unwrap();
        assert_eq!(chat.id, "Qwen3-4B-Q4_K_M");
        assert_eq!(chat.size_bytes, 10);
        assert_eq!(chat.mmproj_path, None);

        let vision = models.iter().find(|m| m.group == "vision").unwrap();
        assert!(vision.mmproj_path.as_ref().unwrap().ends_with("mmproj-MiniCPM-V-4.6-Q8_0.gguf"));
    }
}
