//! Detect a gateway the user already started.
//!
//! The gateway keeps a stable access token at `<config-dir>/access-token`
//! (0600) and serves `/health` publicly plus `/gateway-info` behind that
//! token. Probing localhost with that token therefore proves both "a gateway
//! is listening" and "it is the same install", without a manual profile.

use std::env;
use std::path::{Path, PathBuf};

use crate::probe::Probe;
use crate::profiles::{normalize_url, LOCALE_EN};

pub const DEFAULT_LOCAL_URL: &str = "http://127.0.0.1:3100";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Detected {
    pub url: String,
    pub token: String,
    pub version: Option<String>,
}

/// Gateway config dir used for the token: `VOLTO_CONFIG_DIR` first, then
/// `~/.volto` (the CLI default).
pub fn config_dir() -> Option<PathBuf> {
    if let Some(dir) = env::var("VOLTO_CONFIG_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Some(PathBuf::from(dir));
    }
    env::var("HOME")
        .ok()
        .map(|home| Path::new(&home).join(".volto"))
}

/// The persisted token, trimmed, only when it has the gateway's shape.
pub fn read_access_token(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join("access-token")).ok()?;
    let token = raw.trim();
    is_access_token(token).then(|| token.to_string())
}

/// 32 random bytes rendered as 43 base64url characters.
pub fn is_access_token(value: &str) -> bool {
    value.len() == 43
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Probe order: explicit override, the active profile's URL, the default port.
pub fn candidates(env_override: Option<&str>, active_url: Option<&str>) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for value in [env_override, active_url, Some(DEFAULT_LOCAL_URL)] {
        let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
            continue;
        };
        let Ok(normalized) = normalize_url(value) else {
            continue;
        };
        if !urls.contains(&normalized) {
            urls.push(normalized);
        }
    }
    urls
}

/// First candidate that answers an authenticated `/gateway-info`.
pub fn detect(
    probe: &dyn Fn(&str, Option<&str>) -> Probe,
    token: &str,
    candidates: &[String],
) -> Option<Detected> {
    for url in candidates {
        if let Probe::Online { version, .. } = probe(url, Some(token)) {
            return Some(Detected {
                url: url.clone(),
                token: token.to_string(),
                version,
            });
        }
    }
    None
}

/// Label for the adopted profile.
pub fn detected_label(locale: &str) -> &'static str {
    if locale == LOCALE_EN {
        "Local gateway (detected)"
    } else {
        "本机网关（已检测）"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "volto-discovery-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_only_the_gateway_token_shape() {
        assert!(is_access_token(&"a".repeat(43)));
        assert!(!is_access_token(&"a".repeat(42)));
        assert!(!is_access_token(&format!("{}!", "a".repeat(42))));
    }

    #[test]
    fn reads_a_trimmed_token_from_the_config_dir() {
        let dir = temp_dir("token");
        fs::write(dir.join("access-token"), format!("{}\n", "b".repeat(43))).unwrap();
        assert_eq!(read_access_token(&dir), Some("b".repeat(43)));
        fs::write(dir.join("access-token"), "nope").unwrap();
        assert_eq!(read_access_token(&dir), None);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn candidate_order_is_override_active_default_without_duplicates() {
        assert_eq!(
            candidates(
                Some("http://127.0.0.1:3101"),
                Some("http://127.0.0.1:3100/")
            ),
            vec![
                "http://127.0.0.1:3101".to_string(),
                "http://127.0.0.1:3100".to_string()
            ]
        );
        assert_eq!(
            candidates(None, None),
            vec![DEFAULT_LOCAL_URL.to_string()]
        );
    }

    #[test]
    fn returns_the_first_authenticated_candidate() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let probe = {
            let seen = std::sync::Arc::clone(&seen);
            move |url: &str, _token: Option<&str>| {
                seen.lock().unwrap().push(url.to_string());
                if url.ends_with(":3100") {
                    Probe::Online {
                        version: Some("0.2.1".into()),
                        mode: Some("local".into()),
                    }
                } else {
                    Probe::Offline {
                        error: "no".into(),
                    }
                }
            }
        };
        let urls = candidates(None, Some("http://127.0.0.1:3100"));
        let found = detect(&probe, &"c".repeat(43), &urls).unwrap();
        assert_eq!(found.url, "http://127.0.0.1:3100");
        assert_eq!(found.version.as_deref(), Some("0.2.1"));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
}
