// Minimal GGUF metadata reader: parses only the header key/value block (never
// tensor data) to learn a model's layer count, native context, KV heads, and
// head dim — enough to estimate KV-cache memory. std only.
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct GgufInfo {
    pub n_layers: u32,
    pub n_ctx_train: u32,
    pub n_kv_heads: u32,
    pub head_dim: u32,
}

enum Val {
    U32(u32),
    U64(u64),
    Str(String),
    Other,
}

fn read_u32<R: Read>(r: &mut R) -> Option<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).ok()?;
    Some(u32::from_le_bytes(b))
}

fn read_u64<R: Read>(r: &mut R) -> Option<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b).ok()?;
    Some(u64::from_le_bytes(b))
}

fn read_str<R: Read>(r: &mut R) -> Option<String> {
    let len = read_u64(r)? as usize;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn skip_n<R: Read>(r: &mut R, n: u64) -> Option<()> {
    let mut rem = n;
    let mut buf = [0u8; 4096];
    while rem > 0 {
        let take = rem.min(4096) as usize;
        r.read_exact(&mut buf[..take]).ok()?;
        rem -= take as u64;
    }
    Some(())
}

// Byte size of a fixed-width GGUF scalar type, if it is one.
fn fixed_size(t: u32) -> Option<u64> {
    match t {
        0 | 1 | 7 => Some(1), // u8, i8, bool
        2 | 3 => Some(2),     // u16, i16
        4 | 5 | 6 => Some(4), // u32, i32, f32
        10 | 11 | 12 => Some(8), // u64, i64, f64
        _ => None,
    }
}

fn skip_value<R: Read>(r: &mut R, t: u32) -> Option<()> {
    if let Some(sz) = fixed_size(t) {
        return skip_n(r, sz);
    }
    match t {
        8 => {
            let len = read_u64(r)?;
            skip_n(r, len)
        }
        9 => {
            let et = read_u32(r)?;
            let n = read_u64(r)?;
            if let Some(sz) = fixed_size(et) {
                skip_n(r, n.checked_mul(sz)?)
            } else {
                for _ in 0..n {
                    skip_value(r, et)?;
                }
                Some(())
            }
        }
        _ => None,
    }
}

// Read a metadata value, keeping the scalar/string kinds we may need and
// skipping (without allocating) arrays and floats we don't.
fn read_value<R: Read>(r: &mut R, t: u32) -> Option<Val> {
    match t {
        4 | 5 => Some(Val::U32(read_u32(r)?)),
        0 | 1 | 7 => {
            let mut b = [0u8; 1];
            r.read_exact(&mut b).ok()?;
            Some(Val::U32(b[0] as u32))
        }
        2 | 3 => {
            let mut b = [0u8; 2];
            r.read_exact(&mut b).ok()?;
            Some(Val::U32(u16::from_le_bytes(b) as u32))
        }
        10 | 11 => Some(Val::U64(read_u64(r)?)),
        8 => Some(Val::Str(read_str(r)?)),
        6 => {
            skip_n(r, 4)?;
            Some(Val::Other)
        }
        12 => {
            skip_n(r, 8)?;
            Some(Val::Other)
        }
        9 => {
            let et = read_u32(r)?;
            let n = read_u64(r)?;
            if let Some(sz) = fixed_size(et) {
                skip_n(r, n.checked_mul(sz)?)?;
            } else {
                for _ in 0..n {
                    skip_value(r, et)?;
                }
            }
            Some(Val::Other)
        }
        _ => None,
    }
}

pub fn read_info(path: &Path) -> Option<GgufInfo> {
    let mut r = BufReader::new(File::open(path).ok()?);
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic).ok()?;
    if &magic != b"GGUF" {
        return None;
    }
    let _version = read_u32(&mut r)?;
    let _tensor_count = read_u64(&mut r)?;
    let kv_count = read_u64(&mut r)?;

    let mut map: HashMap<String, Val> = HashMap::new();
    for _ in 0..kv_count {
        let key = read_str(&mut r)?;
        let vtype = read_u32(&mut r)?;
        let val = read_value(&mut r, vtype)?;
        map.insert(key, val);
    }

    let get_u32 = |k: &str| -> Option<u32> {
        match map.get(k)? {
            Val::U32(v) => Some(*v),
            Val::U64(v) => Some(*v as u32),
            _ => None,
        }
    };
    let arch = match map.get("general.architecture")? {
        Val::Str(s) => s.clone(),
        _ => return None,
    };
    let n_layers = get_u32(&format!("{arch}.block_count"))?;
    let n_ctx_train = get_u32(&format!("{arch}.context_length"))?;
    let n_kv_heads = get_u32(&format!("{arch}.attention.head_count_kv"))?;
    let head_dim = get_u32(&format!("{arch}.attention.key_length")).or_else(|| {
        let n_embd = get_u32(&format!("{arch}.embedding_length"))?;
        let n_head = get_u32(&format!("{arch}.attention.head_count"))?;
        if n_head == 0 {
            None
        } else {
            Some(n_embd / n_head)
        }
    })?;
    Some(GgufInfo {
        n_layers,
        n_ctx_train,
        n_kv_heads,
        head_dim,
    })
}

/// Bytes of KV cache per token: K and V, f16 (2 bytes), across all layers/heads.
pub fn kv_bytes_per_token(info: &GgufInfo) -> u64 {
    4 * info.n_layers as u64 * info.n_kv_heads as u64 * info.head_dim as u64
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // --- synthetic GGUF builder (little-endian) ---
    fn put_str(out: &mut Vec<u8>, s: &str) {
        out.extend_from_slice(&(s.len() as u64).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    }
    fn kv_str(out: &mut Vec<u8>, key: &str, val: &str) {
        put_str(out, key);
        out.extend_from_slice(&8u32.to_le_bytes()); // type STRING
        put_str(out, val);
    }
    fn kv_u32(out: &mut Vec<u8>, key: &str, val: u32) {
        put_str(out, key);
        out.extend_from_slice(&4u32.to_le_bytes()); // type UINT32
        out.extend_from_slice(&val.to_le_bytes());
    }

    fn synthetic_gguf() -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"GGUF");
        out.extend_from_slice(&3u32.to_le_bytes()); // version
        out.extend_from_slice(&0u64.to_le_bytes()); // tensor_count
        out.extend_from_slice(&6u64.to_le_bytes()); // kv_count
        kv_str(&mut out, "general.architecture", "llama");
        kv_u32(&mut out, "llama.block_count", 4);
        kv_u32(&mut out, "llama.context_length", 2048);
        kv_u32(&mut out, "llama.attention.head_count_kv", 2);
        kv_u32(&mut out, "llama.embedding_length", 64);
        kv_u32(&mut out, "llama.attention.head_count", 8);
        out
    }

    #[test]
    fn reads_synthetic_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("m.gguf");
        std::fs::File::create(&p).unwrap().write_all(&synthetic_gguf()).unwrap();
        let info = read_info(&p).unwrap();
        assert_eq!(info.n_layers, 4);
        assert_eq!(info.n_ctx_train, 2048);
        assert_eq!(info.n_kv_heads, 2);
        assert_eq!(info.head_dim, 8); // embedding_length 64 / head_count 8
    }

    #[test]
    fn garbage_file_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.gguf");
        std::fs::write(&p, b"not a gguf file at all").unwrap();
        assert_eq!(read_info(&p), None);
    }

    #[test]
    fn kv_bytes_per_token_math() {
        let info = GgufInfo { n_layers: 4, n_ctx_train: 2048, n_kv_heads: 2, head_dim: 8 };
        // 4 * 4 * 2 * 8 = 256 bytes/token
        assert_eq!(kv_bytes_per_token(&info), 256);
    }
}
