//! Workspace layout and visit state.
//!
//! Workspace root resolution (in order):
//! 1. `MOLEMAP_HOME` env var,
//! 2. `<git root>/molemap/workspace` when the cwd is inside a git checkout,
//! 3. `~/molemap`.
//!
//! Per-visit layout (`visits/<YYYY-MM-DD[-b]>/`):
//! ```text
//! raw/{body,region-<name>}/     originals, never modified
//! work/images/<region>/         JPEG, max 3200px, COLMAP input
//! work/masks/                   reserved
//! work/colmap/{database.db,sparse,sparse-txt,sparse-norm,sparse-norm-txt}
//! work/opensplat/               gaussian-splat training
//! work/logs/                    per-tool logs
//! dist/                         derived artifacts, the only thing uploaded
//! visit.json                    stage + params + timings + stats
//! ```

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Ingested,
    Reconstructed,
    Splatted,
    Detected,
    Bundled,
    Uploaded,
}

impl std::fmt::Display for Stage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Stage::Ingested => "ingested",
            Stage::Reconstructed => "reconstructed",
            Stage::Splatted => "splatted",
            Stage::Detected => "detected",
            Stage::Bundled => "bundled",
            Stage::Uploaded => "uploaded",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitMeta {
    pub visit_id: String,
    pub capture_date: String,
    pub stage: Stage,
    #[serde(default)]
    pub params: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub timings: BTreeMap<String, f64>,
    #[serde(default)]
    pub stats: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct Visit {
    /// Directory name, e.g. `2026-08-10` or `2026-08-10-b`.
    pub name: String,
    pub dir: PathBuf,
    pub meta: VisitMeta,
}

impl Visit {
    pub fn raw_dir(&self) -> PathBuf {
        self.dir.join("raw")
    }
    pub fn images_dir(&self) -> PathBuf {
        self.dir.join("work/images")
    }
    pub fn masks_dir(&self) -> PathBuf {
        self.dir.join("work/masks")
    }
    pub fn colmap_dir(&self) -> PathBuf {
        self.dir.join("work/colmap")
    }
    pub fn database_path(&self) -> PathBuf {
        self.colmap_dir().join("database.db")
    }
    pub fn sparse_dir(&self) -> PathBuf {
        self.colmap_dir().join("sparse")
    }
    pub fn sparse_txt_dir(&self) -> PathBuf {
        self.colmap_dir().join("sparse-txt")
    }
    pub fn sparse_norm_dir(&self) -> PathBuf {
        self.colmap_dir().join("sparse-norm")
    }
    pub fn sparse_norm_txt_dir(&self) -> PathBuf {
        self.colmap_dir().join("sparse-norm-txt")
    }
    pub fn opensplat_dir(&self) -> PathBuf {
        self.dir.join("work/opensplat")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.dir.join("work/logs")
    }
    pub fn dist_dir(&self) -> PathBuf {
        self.dir.join("dist")
    }
    pub fn crops_dir(&self) -> PathBuf {
        self.dist_dir().join("crops/detected")
    }
    fn meta_path(dir: &Path) -> PathBuf {
        dir.join("visit.json")
    }

    pub fn load(dir: &Path) -> Result<Visit> {
        let body = std::fs::read_to_string(Self::meta_path(dir))
            .with_context(|| format!("read {}", Self::meta_path(dir).display()))?;
        let meta: VisitMeta = serde_json::from_str(&body)
            .with_context(|| format!("parse {}", Self::meta_path(dir).display()))?;
        Ok(Visit {
            name: dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            dir: dir.to_path_buf(),
            meta,
        })
    }

    pub fn save(&self) -> Result<()> {
        let body = serde_json::to_string_pretty(&self.meta)?;
        std::fs::write(Self::meta_path(&self.dir), body)
            .with_context(|| format!("write {}", Self::meta_path(&self.dir).display()))?;
        Ok(())
    }

    pub fn ensure_layout(&self) -> Result<()> {
        for d in [
            self.raw_dir(),
            self.images_dir(),
            self.masks_dir(),
            self.colmap_dir(),
            self.opensplat_dir(),
            self.logs_dir(),
            self.dist_dir(),
        ] {
            std::fs::create_dir_all(&d).with_context(|| format!("create {}", d.display()))?;
        }
        Ok(())
    }

    pub fn set_stat(&mut self, key: &str, value: serde_json::Value) {
        self.meta.stats.insert(key.to_string(), value);
    }

    pub fn stat_u64(&self, key: &str) -> Option<u64> {
        self.meta.stats.get(key).and_then(|v| v.as_u64())
    }

    pub fn record_timing(&mut self, stage: &str, secs: f64) {
        self.meta
            .timings
            .insert(stage.to_string(), (secs * 100.0).round() / 100.0);
    }

    /// Gate: require the visit to have reached `stage`.
    pub fn require_stage(&self, stage: Stage, hint: &str) -> Result<()> {
        if self.meta.stage < stage {
            bail!(
                "visit {} is at stage '{}', needs '{}' first — {}",
                self.name,
                self.meta.stage,
                stage,
                hint
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct Workspace {
    pub root: PathBuf,
}

impl Workspace {
    /// Resolve the workspace root (see module docs). Does not create it.
    pub fn locate() -> Workspace {
        if let Ok(home) = std::env::var("MOLEMAP_HOME") {
            if !home.is_empty() {
                return Workspace {
                    root: PathBuf::from(home),
                };
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            let mut dir: Option<&Path> = Some(cwd.as_path());
            while let Some(d) = dir {
                if d.join(".git").exists() {
                    return Workspace {
                        root: d.join("molemap/workspace"),
                    };
                }
                dir = d.parent();
            }
        }
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        Workspace {
            root: home.join("molemap"),
        }
    }

    pub fn visits_dir(&self) -> PathBuf {
        self.root.join("visits")
    }

    pub fn init(&self) -> Result<()> {
        std::fs::create_dir_all(self.visits_dir())
            .with_context(|| format!("create {}", self.visits_dir().display()))?;
        Ok(())
    }

    pub fn list_visits(&self) -> Result<Vec<Visit>> {
        let mut out = Vec::new();
        let dir = self.visits_dir();
        if !dir.exists() {
            return Ok(out);
        }
        let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir() && Visit::meta_path(p).exists())
            .collect();
        entries.sort();
        for e in entries {
            out.push(Visit::load(&e)?);
        }
        Ok(out)
    }

    /// Resolve `--visit ID` (directory name) or default to the latest visit.
    pub fn resolve(&self, id: Option<&str>) -> Result<Visit> {
        match id {
            Some(name) => {
                let dir = self.visits_dir().join(name);
                if !Visit::meta_path(&dir).exists() {
                    bail!("no visit '{}' in {}", name, self.visits_dir().display());
                }
                Visit::load(&dir)
            }
            None => {
                let visits = self.list_visits()?;
                visits.into_iter().next_back().with_context(|| {
                    format!(
                        "no visits in {} — run `molemap ingest <dir>` first",
                        self.visits_dir().display()
                    )
                })
            }
        }
    }

    /// Create a new visit directory named after the capture date, suffixing
    /// `-b`, `-c`, ... on collision.
    pub fn create_visit(&self, capture_date: &str) -> Result<Visit> {
        self.init()?;
        let mut name = capture_date.to_string();
        let mut suffix = b'b';
        while self.visits_dir().join(&name).exists() {
            if suffix > b'z' {
                bail!("too many visits named {capture_date}");
            }
            name = format!("{}-{}", capture_date, suffix as char);
            suffix += 1;
        }
        let dir = self.visits_dir().join(&name);
        let visit = Visit {
            name,
            dir,
            meta: VisitMeta {
                visit_id: uuid::Uuid::new_v4().to_string(),
                capture_date: capture_date.to_string(),
                stage: Stage::Ingested,
                params: BTreeMap::new(),
                timings: BTreeMap::new(),
                stats: BTreeMap::new(),
            },
        };
        visit.ensure_layout()?;
        visit.save()?;
        Ok(visit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_ordering() {
        assert!(Stage::Ingested < Stage::Reconstructed);
        assert!(Stage::Reconstructed < Stage::Splatted);
        assert!(Stage::Splatted < Stage::Detected);
        assert!(Stage::Detected < Stage::Bundled);
        assert!(Stage::Bundled < Stage::Uploaded);
    }

    #[test]
    fn stage_serde_lowercase() {
        assert_eq!(
            serde_json::to_string(&Stage::Reconstructed).unwrap(),
            "\"reconstructed\""
        );
        let s: Stage = serde_json::from_str("\"bundled\"").unwrap();
        assert_eq!(s, Stage::Bundled);
    }

    #[test]
    fn visit_create_load_and_collision_suffix() {
        let tmp = std::env::temp_dir().join(format!("molemap-ws-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let ws = Workspace { root: tmp.clone() };
        let v1 = ws.create_visit("2026-08-10").unwrap();
        assert_eq!(v1.name, "2026-08-10");
        let v2 = ws.create_visit("2026-08-10").unwrap();
        assert_eq!(v2.name, "2026-08-10-b");
        let loaded = ws.resolve(Some("2026-08-10")).unwrap();
        assert_eq!(loaded.meta.visit_id, v1.meta.visit_id);
        assert_eq!(loaded.meta.stage, Stage::Ingested);
        // Latest resolves to -b (lexicographically last).
        let latest = ws.resolve(None).unwrap();
        assert_eq!(latest.name, "2026-08-10-b");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
