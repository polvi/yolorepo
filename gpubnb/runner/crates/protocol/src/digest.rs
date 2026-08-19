//! §8 Model digest: SHA256 over the sorted list of `(relative_path, SHA256(file))`
//! pairs of the weights directory, each encoded `path || 0x00 || sha256 || 0x0a`.

use crate::Result;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// One entry of the digest input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestEntry {
    /// Relative path, `/`-separated, no leading `./`.
    pub path: String,
    pub sha256: [u8; 32],
}

/// Walk `dir`, hash every regular file, sort by relative path (byte order).
pub fn model_digest_entries(dir: &Path) -> Result<Vec<DigestEntry>> {
    let mut entries = Vec::new();
    for e in walkdir::WalkDir::new(dir).follow_links(false) {
        let e = e.map_err(|e| std::io::Error::other(e.to_string()))?;
        if !e.file_type().is_file() {
            continue;
        }
        let rel = e
            .path()
            .strip_prefix(dir)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let rel = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        let mut f = std::fs::File::open(e.path())?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        entries.push(DigestEntry { path: rel, sha256: h.finalize().into() });
    }
    entries.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    Ok(entries)
}

/// Combine entries per §8.
pub fn digest_from_entries(entries: &[DigestEntry]) -> [u8; 32] {
    let mut h = Sha256::new();
    for e in entries {
        h.update(e.path.as_bytes());
        h.update([0u8]);
        h.update(e.sha256);
        h.update([0x0au8]);
    }
    h.finalize().into()
}

/// Model digest of a weights directory.
pub fn model_digest(dir: &Path) -> Result<[u8; 32]> {
    Ok(digest_from_entries(&model_digest_entries(dir)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_of_tree_is_order_independent_of_walk() {
        let tmp = std::env::temp_dir().join(format!("gpubnb-digest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("sub")).unwrap();
        std::fs::write(tmp.join("b.bin"), b"bbb").unwrap();
        std::fs::write(tmp.join("a.bin"), b"aaa").unwrap();
        std::fs::write(tmp.join("sub/c.bin"), b"").unwrap();
        let entries = model_digest_entries(&tmp).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            vec!["a.bin", "b.bin", "sub/c.bin"]
        );
        let d = model_digest(&tmp).unwrap();
        // hand computation
        let mut h = Sha256::new();
        for (p, c) in [("a.bin", &b"aaa"[..]), ("b.bin", &b"bbb"[..]), ("sub/c.bin", &b""[..])] {
            h.update(p.as_bytes());
            h.update([0]);
            let fh: [u8; 32] = Sha256::digest(c).into();
            h.update(fh);
            h.update([0x0a]);
        }
        let expect: [u8; 32] = h.finalize().into();
        assert_eq!(d, expect);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
