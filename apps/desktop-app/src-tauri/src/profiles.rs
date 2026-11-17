//! Profile types and the pure rules around them.
//!
//! Nothing here touches the filesystem or Tauri: the desktop shell and the
//! renderer both depend on these answers, so they are unit-tested directly.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

pub const DEFAULT_PROFILE_ID: &str = "local";
pub const DEFAULT_LABEL: &str = "本机网关";
const MAX_LABEL_CHARS: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Local,
    Remote,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    /// Normalized origin. Empty only for a managed local profile.
    pub url: String,
    pub managed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProfile {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    pub url: String,
    pub managed: bool,
    pub has_token: bool,
}

pub const THEME_SYSTEM: &str = "system";
pub const THEME_LIGHT: &str = "light";
pub const THEME_DARK: &str = "dark";
pub const LOCALE_ZH: &str = "zh";
pub const LOCALE_EN: &str = "en";

/// Unknown values fall back to the default instead of failing the whole store.
pub fn normalize_theme(value: &str) -> String {
    match value {
        THEME_LIGHT => THEME_LIGHT,
        THEME_DARK => THEME_DARK,
        _ => THEME_SYSTEM,
    }
    .to_string()
}

pub fn normalize_locale(value: &str) -> String {
    if value.eq_ignore_ascii_case(LOCALE_EN) {
        LOCALE_EN.to_string()
    } else {
        LOCALE_ZH.to_string()
    }
}

fn default_theme() -> String {
    THEME_SYSTEM.to_string()
}

fn default_locale() -> String {
    LOCALE_ZH.to_string()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Persisted {
    pub profiles: Vec<Profile>,
    pub active_profile_id: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_locale")]
    pub locale: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub profile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub degraded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl Status {
    pub fn idle(profile_id: &str) -> Self {
        Self::new("idle", profile_id)
    }

    pub fn starting(profile_id: &str, detail: Option<String>) -> Self {
        Self {
            detail,
            ..Self::new("starting", profile_id)
        }
    }

    fn new(state: &str, profile_id: &str) -> Self {
        Self {
            state: state.to_string(),
            profile_id: profile_id.to_string(),
            url: None,
            version: None,
            mode: None,
            degraded: false,
            detail: None,
            error: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellState {
    pub profiles: Vec<PublicProfile>,
    pub active_profile_id: String,
    pub status: Status,
    pub theme: String,
    pub locale: String,
    pub platform: String,
    pub app_version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDraft {
    #[serde(default)]
    pub id: Option<String>,
    pub label: String,
    pub kind: Kind,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub managed: Option<bool>,
}

pub fn default_persisted() -> Persisted {
    Persisted {
        profiles: vec![Profile {
            id: DEFAULT_PROFILE_ID.to_string(),
            label: DEFAULT_LABEL.to_string(),
            kind: Kind::Local,
            url: String::new(),
            managed: true,
            token: None,
        }],
        active_profile_id: DEFAULT_PROFILE_ID.to_string(),
        theme: default_theme(),
        locale: default_locale(),
    }
}

fn has_scheme(value: &str) -> bool {
    value
        .split_once("://")
        .is_some_and(|(scheme, _)| {
            !scheme.is_empty()
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        })
}

/// Accepts `host:port`, `http://host`, `https://host/` and returns the origin.
/// Anything a browser would treat as more than an origin is refused.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("网关地址不能为空".into());
    }
    let candidate = if has_scheme(trimmed) {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = Url::parse(&candidate).map_err(|_| "网关地址无效".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("网关地址只支持 http:// 或 https://".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("网关地址不能包含用户名或密码".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("网关地址不能带查询参数或锚点".into());
    }
    if url.path() != "/" {
        return Err("网关地址只填到端口，不要带路径".into());
    }
    if url.host_str().is_none() {
        return Err("网关地址无效".into());
    }
    Ok(url.origin().ascii_serialization())
}

/// Validate a draft and produce the profile to store. `id` is chosen by the
/// caller (existing id when editing, a fresh UUID when creating).
pub fn validate_draft(
    draft: &ProfileDraft,
    id: String,
    existing: Option<&Profile>,
) -> Result<Profile, String> {
    let label = draft.label.trim();
    if label.is_empty() {
        return Err("名称不能为空".into());
    }
    if label.chars().count() > MAX_LABEL_CHARS {
        return Err(format!("名称不能超过 {MAX_LABEL_CHARS} 个字符"));
    }

    let token = draft
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let (kind, url, managed) = match draft.kind {
        Kind::Remote => {
            let url = normalize_url(draft.url.as_deref().unwrap_or(""))?;
            (Kind::Remote, url, false)
        }
        Kind::Local => {
            let managed = draft.managed.unwrap_or(true);
            let url = match draft.url.as_deref().map(str::trim) {
                Some(value) if !value.is_empty() => normalize_url(value)?,
                _ => String::new(),
            };
            if !managed && url.is_empty() {
                return Err("直连本机网关需要填写地址".into());
            }
            (Kind::Local, url, managed)
        }
    };

    // A blank token input means "keep the stored one" only while it still
    // belongs to this destination.
    let token = token.or_else(|| {
        existing
            .filter(|profile| {
                profile.kind == kind
                    && profile.url == url
                    && (kind == Kind::Remote || !managed)
            })
            .and_then(|profile| profile.token.clone())
    });

    Ok(Profile {
        id,
        label: label.to_string(),
        kind,
        url,
        managed,
        token,
    })
}

pub fn upsert(profiles: &[Profile], profile: Profile) -> Vec<Profile> {
    match profiles.iter().position(|entry| entry.id == profile.id) {
        Some(index) => {
            let mut next = profiles.to_vec();
            next[index] = profile;
            next
        }
        None => {
            let mut next = profiles.to_vec();
            next.push(profile);
            next
        }
    }
}

pub fn remove(
    profiles: &[Profile],
    id: &str,
    active_profile_id: &str,
) -> Result<(Vec<Profile>, String), String> {
    if !profiles.iter().any(|entry| entry.id == id) {
        return Err("网关不存在".into());
    }
    if profiles.len() <= 1 {
        return Err("至少保留一个网关".into());
    }
    let next: Vec<Profile> = profiles
        .iter()
        .filter(|entry| entry.id != id)
        .cloned()
        .collect();
    let next_active = if active_profile_id == id {
        next.first()
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| DEFAULT_PROFILE_ID.to_string())
    } else {
        active_profile_id.to_string()
    };
    Ok((next, next_active))
}

fn parse_profile(value: &Value) -> Option<Profile> {
    let id = value.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let label = value.get("label")?.as_str()?.trim();
    if label.is_empty() {
        return None;
    }
    let kind = match value.get("kind")?.as_str()? {
        "local" => Kind::Local,
        "remote" => Kind::Remote,
        _ => return None,
    };
    let raw_url = value.get("url")?.as_str()?;
    let managed = value.get("managed")?.as_bool()?;
    let url = if raw_url.is_empty() {
        if kind == Kind::Remote || !managed {
            return None;
        }
        String::new()
    } else {
        normalize_url(raw_url).ok()?
    };
    let token = match value.get("token") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.trim().is_empty() => None,
        Some(Value::String(value)) => Some(value.trim().to_string()),
        Some(_) => return None,
    };
    Some(Profile {
        id: id.to_string(),
        label: label.to_string(),
        kind,
        url,
        managed: if kind == Kind::Remote { false } else { managed },
        token,
    })
}

/// Recover usable profiles from whatever is on disk. A corrupt store must not
/// brick the app: invalid entries are dropped and an empty result falls back
/// to the default profile.
pub fn sanitize(value: &Value) -> Persisted {
    let fallback = default_persisted();
    let Some(entries) = value.get("profiles").and_then(Value::as_array) else {
        return fallback;
    };
    let mut profiles: Vec<Profile> = Vec::new();
    for entry in entries {
        let Some(profile) = parse_profile(entry) else {
            continue;
        };
        if profiles.iter().any(|known| known.id == profile.id) {
            continue;
        }
        profiles.push(profile);
    }
    if profiles.is_empty() {
        return fallback;
    }
    let requested = value
        .get("activeProfileId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let active_profile_id = if profiles.iter().any(|entry| entry.id == requested) {
        requested.to_string()
    } else {
        profiles[0].id.clone()
    };
    Persisted {
        profiles,
        active_profile_id,
        theme: value
            .get("theme")
            .and_then(Value::as_str)
            .map(normalize_theme)
            .unwrap_or_else(default_theme),
        locale: value
            .get("locale")
            .and_then(Value::as_str)
            .map(normalize_locale)
            .unwrap_or_else(default_locale),
    }
}

pub fn to_public(profiles: &[Profile]) -> Vec<PublicProfile> {
    profiles
        .iter()
        .map(|profile| PublicProfile {
            id: profile.id.clone(),
            label: profile.label.clone(),
            kind: profile.kind,
            url: profile.url.clone(),
            managed: profile.managed,
            has_token: profile.token.as_deref().is_some_and(|token| !token.is_empty()),
        })
        .collect()
}

/// URL handed to the gateway webview: a token is exchanged for a cookie on
/// this first navigation.
pub fn entry_url(url: &str, token: Option<&str>) -> Result<String, String> {
    let mut parsed = Url::parse(url).map_err(|error| error.to_string())?;
    if let Some(token) = token.filter(|token| !token.is_empty()) {
        parsed.query_pairs_mut().append_pair("token", token);
    }
    Ok(parsed.to_string())
}

/// Add the desktop presentation contract to an entry URL. The web boot script
/// reads these before paint; replacing (not appending) keeps reloads stable.
pub fn with_preferences(
    url: &str,
    theme: &str,
    locale: &str,
    platform: &str,
) -> Result<String, String> {
    let mut parsed = Url::parse(url).map_err(|error| error.to_string())?;
    let kept: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(key, _)| {
            !matches!(
                key.as_ref(),
                "volto_shell" | "volto_theme" | "volto_locale" | "volto_platform"
            )
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    parsed.set_query(None);
    {
        let mut query = parsed.query_pairs_mut();
        for (key, value) in kept {
            query.append_pair(&key, &value);
        }
        query.append_pair("volto_shell", "desktop");
        query.append_pair("volto_theme", &normalize_theme(theme));
        query.append_pair("volto_locale", &normalize_locale(locale));
        query.append_pair("volto_platform", platform);
    }
    Ok(parsed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn remote() -> Profile {
        Profile {
            id: "remote".into(),
            label: "Remote".into(),
            kind: Kind::Remote,
            url: "https://gw.example.com".into(),
            managed: false,
            token: Some("remote-token".into()),
        }
    }

    fn draft(kind: Kind) -> ProfileDraft {
        ProfileDraft {
            id: None,
            label: "网关".into(),
            kind,
            url: None,
            token: None,
            managed: None,
        }
    }

    #[test]
    fn adds_http_when_scheme_is_missing() {
        assert_eq!(normalize_url("localhost:3100").unwrap(), "http://localhost:3100");
        assert_eq!(
            normalize_url("http://127.0.0.1:3100").unwrap(),
            "http://127.0.0.1:3100"
        );
    }

    #[test]
    fn strips_trailing_slash_and_keeps_origin_only() {
        assert_eq!(normalize_url("https://gw.example.com/").unwrap(), "https://gw.example.com");
    }

    #[test]
    fn rejects_what_is_not_an_origin() {
        assert!(normalize_url("").is_err());
        assert!(normalize_url("file:///tmp/x").is_err());
        assert!(normalize_url("ftp://host").is_err());
        assert!(normalize_url("http://user:pass@host").is_err());
        assert!(normalize_url("http://host/api").is_err());
        assert!(normalize_url("http://host?x=1").is_err());
        assert!(normalize_url("http://host#frag").is_err());
    }

    #[test]
    fn validates_profile_drafts() {
        assert_eq!(
            validate_draft(&draft(Kind::Local), "id".into(), None).unwrap(),
            Profile {
                id: "id".into(),
                label: "网关".into(),
                kind: Kind::Local,
                url: String::new(),
                managed: true,
                token: None,
            }
        );

        let mut remote_draft = draft(Kind::Remote);
        remote_draft.url = Some("https://gw.example.com/".into());
        let profile = validate_draft(&remote_draft, "r".into(), None).unwrap();
        assert_eq!(profile.url, "https://gw.example.com");
        assert!(!profile.managed);

        let mut unmanaged_local = draft(Kind::Local);
        unmanaged_local.managed = Some(false);
        assert_eq!(
            validate_draft(&unmanaged_local, "l".into(), None).unwrap_err(),
            "直连本机网关需要填写地址"
        );

        let mut blank = draft(Kind::Remote);
        blank.label = "  ".into();
        assert_eq!(validate_draft(&blank, "x".into(), None).unwrap_err(), "名称不能为空");

        let mut long = draft(Kind::Remote);
        long.label = "x".repeat(61);
        assert_eq!(
            validate_draft(&long, "x".into(), None).unwrap_err(),
            "名称不能超过 60 个字符"
        );
    }

    #[test]
    fn keeps_a_token_only_for_the_same_destination() {
        let existing = remote();
        let mut edit = draft(Kind::Remote);
        edit.id = Some("remote".into());
        edit.label = "Renamed".into();
        edit.url = Some("https://gw.example.com".into());
        let kept = validate_draft(&edit, "remote".into(), Some(&existing)).unwrap();
        assert_eq!(kept.token.as_deref(), Some("remote-token"));

        let mut moved = edit.clone();
        moved.url = Some("https://other.example.com".into());
        let dropped = validate_draft(&moved, "remote".into(), Some(&existing)).unwrap();
        assert_eq!(dropped.token, None);
    }

    #[test]
    fn removes_profiles_but_never_the_last_one() {
        let profiles = vec![default_persisted().profiles[0].clone(), remote()];
        assert_eq!(remove(&profiles, "nope", "local").unwrap_err(), "网关不存在");
        assert_eq!(remove(&profiles[..1], "local", "local").unwrap_err(), "至少保留一个网关");
        let (next, active) = remove(&profiles, "local", "local").unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(active, "remote");
    }

    #[test]
    fn sanitizes_corrupt_stores() {
        assert_eq!(sanitize(&json!(null)), default_persisted());
        assert_eq!(sanitize(&json!({"profiles": []})), default_persisted());

        let value = json!({
            "profiles": [
                {"id": "a", "label": "A", "kind": "local", "url": "", "managed": true},
                {"id": "a", "label": "A2", "kind": "local", "url": "", "managed": true},
                {"id": "b", "label": "B", "kind": "remote", "url": "file:///etc/passwd", "managed": false},
                {"id": "c", "label": "C", "kind": "remote", "url": "not a url", "managed": false},
                {"id": "d", "label": "D", "kind": "remote", "url": "https://gw", "managed": true, "token": " t "}
            ],
            "activeProfileId": "missing"
        });
        let result = sanitize(&value);
        assert_eq!(result.profiles.len(), 2);
        assert_eq!(result.active_profile_id, "a");
        assert_eq!(result.profiles[1].token.as_deref(), Some("t"));
        assert!(!result.profiles[1].managed);
    }

    #[test]
    fn public_state_hides_tokens() {
        let public = to_public(&[remote()]);
        assert!(public[0].has_token);
        let json = serde_json::to_string(&public).unwrap();
        assert!(!json.contains("remote-token"));
    }

    #[test]
    fn normalizes_presentation_preferences() {
        assert_eq!(normalize_theme("dark"), "dark");
        assert_eq!(normalize_theme("light"), "light");
        assert_eq!(normalize_theme("neon"), "system");
        assert_eq!(normalize_locale("en"), "en");
        assert_eq!(normalize_locale("EN"), "en");
        assert_eq!(normalize_locale("fr"), "zh");
    }

    #[test]
    fn adds_preferences_without_dropping_the_token() {
        let entry = entry_url("http://127.0.0.1:3000", Some("tok")).unwrap();
        let first = with_preferences(&entry, "dark", "en", "darwin").unwrap();
        assert!(first.contains("token=tok"));
        assert!(first.contains("volto_shell=desktop"));
        assert!(first.contains("volto_theme=dark"));
        assert!(first.contains("volto_locale=en"));
        assert!(first.contains("volto_platform=darwin"));

        let second = with_preferences(&first, "light", "zh", "darwin").unwrap();
        assert_eq!(second.matches("volto_theme=").count(), 1);
        assert!(second.contains("volto_theme=light"));
        assert!(second.contains("volto_locale=zh"));
        assert!(second.contains("token=tok"));
    }

    #[test]
    fn builds_the_entry_url_with_the_token() {
        assert_eq!(
            entry_url("http://127.0.0.1:3100", Some("a b")).unwrap(),
            "http://127.0.0.1:3100/?token=a+b"
        );
        assert_eq!(
            entry_url("https://gw.example.com", None).unwrap(),
            "https://gw.example.com/"
        );
    }
}