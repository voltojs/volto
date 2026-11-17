//! Persistence for the gateway profile list. One small JSON file in the
//! application config directory; the sanitizer owns what counts as valid.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::profiles::{default_persisted, sanitize, Persisted};

pub struct ProfileStore {
    path: PathBuf,
}

impl ProfileStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join("gateway-profiles.json"),
        }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Missing, unreadable or corrupt files all fall back to the default
    /// profile instead of failing the app.
    pub fn load(&self) -> Persisted {
        match fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
                .map(|value| sanitize(&value))
                .unwrap_or_else(|_| default_persisted()),
            Err(_) => default_persisted(),
        }
    }

    /// Write through a temporary file so a crash mid-write cannot truncate the
    /// previous list.
    pub fn save(&self, persisted: &Persisted) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建配置目录：{error}"))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(persisted)
            .map_err(|error| format!("无法序列化网关设置：{error}"))?;
        write_private(&tmp, json.as_bytes())?;
        if fs::rename(&tmp, &self.path).is_err() {
            // Windows refuses to rename over an existing file.
            let _ = fs::remove_file(&self.path);
            fs::rename(&tmp, &self.path).map_err(|error| format!("无法保存网关设置：{error}"))?;
        }
        Ok(())
    }
}

impl crate::controller::StoreLike for ProfileStore {
    fn save(&self, persisted: &Persisted) -> Result<(), String> {
        ProfileStore::save(self, persisted)
    }
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("无法写入网关设置：{error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("无法写入网关设置：{error}"))
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|error| format!("无法写入网关设置：{error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("无法写入网关设置：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{Kind, Profile};

    fn temp_dir(tag: &str) -> PathBuf {
        let unique = format!(
            "volto-store-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_loads_the_default_profile() {
        let dir = temp_dir("missing");
        let store = ProfileStore::new(&dir);
        assert_eq!(store.load(), default_persisted());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn round_trips_profiles() {
        let dir = temp_dir("roundtrip");
        let store = ProfileStore::new(&dir);
        let persisted = Persisted {
            profiles: vec![
                default_persisted().profiles[0].clone(),
                Profile {
                    id: "remote".into(),
                    label: "Remote".into(),
                    kind: Kind::Remote,
                    url: "https://gw.example.com".into(),
                    managed: false,
                    token: Some("secret".into()),
                },
            ],
            active_profile_id: "remote".into(),
        };
        store.save(&persisted).unwrap();
        assert_eq!(store.load(), persisted);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(store.path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn corrupt_file_falls_back_to_default() {
        let dir = temp_dir("corrupt");
        let store = ProfileStore::new(&dir);
        fs::write(store.path(), "{not json").unwrap();
        assert_eq!(store.load(), default_persisted());
        fs::remove_dir_all(dir).ok();
    }
}