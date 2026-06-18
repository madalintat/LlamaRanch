use crate::config::Config;
use crate::scanner::Model;

const GB: u64 = 1_000_000_000;

pub fn ngl_for(size_bytes: u64) -> u32 {
    if size_bytes <= 3 * GB {
        99
    } else if size_bytes <= 6 * GB {
        18
    } else {
        6
    }
}

pub fn placement_for(size_bytes: u64) -> &'static str {
    if size_bytes <= 3 * GB {
        "GPU"
    } else if size_bytes <= 6 * GB {
        "Partial"
    } else {
        "CPU"
    }
}

pub fn flags_for(model: &Model, cfg: &Config) -> Vec<String> {
    let host = if cfg.expose_to_network {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    let mut v = vec![
        "-m".into(),
        model.path.clone(),
        "--host".into(),
        host.into(),
        "--port".into(),
        cfg.port.to_string(),
        "--ctx-size".into(),
        "4096".into(),
        "-ngl".into(),
        ngl_for(model.size_bytes).to_string(),
    ];
    if let Some(mm) = &model.mmproj_path {
        v.push("--mmproj".into());
        v.push(mm.clone());
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(size: u64, mmproj: Option<&str>) -> Model {
        Model {
            id: "m".into(),
            name: "m".into(),
            group: "chat".into(),
            path: "/models/m.gguf".into(),
            size_bytes: size,
            mmproj_path: mmproj.map(|s| s.to_string()),
        }
    }

    #[test]
    fn ngl_buckets() {
        assert_eq!(ngl_for(2 * GB), 99);
        assert_eq!(ngl_for(5 * GB), 18);
        assert_eq!(ngl_for(18 * GB), 6);
    }

    #[test]
    fn placement_buckets() {
        assert_eq!(placement_for(2 * GB), "GPU");
        assert_eq!(placement_for(5 * GB), "Partial");
        assert_eq!(placement_for(18 * GB), "CPU");
    }

    #[test]
    fn flags_include_core_and_mmproj() {
        let cfg = Config::default();
        let f = flags_for(&model(2 * GB, Some("/models/mmproj.gguf")), &cfg);
        assert!(f.windows(2).any(|w| w == ["-m", "/models/m.gguf"]));
        assert!(f.windows(2).any(|w| w == ["--host", "127.0.0.1"]));
        assert!(f.windows(2).any(|w| w == ["--port", "2276"]));
        assert!(f.windows(2).any(|w| w == ["-ngl", "99"]));
        assert!(f.windows(2).any(|w| w == ["--mmproj", "/models/mmproj.gguf"]));
    }

    #[test]
    fn expose_flips_host() {
        let mut cfg = Config::default();
        cfg.expose_to_network = true;
        let f = flags_for(&model(2 * GB, None), &cfg);
        assert!(f.windows(2).any(|w| w == ["--host", "0.0.0.0"]));
        assert!(!f.iter().any(|x| x == "--mmproj"));
    }
}
