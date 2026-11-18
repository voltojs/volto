//! The gateway selection state machine.
//!
//! Deliberately free of Tauri types so the whole switch flow runs under plain
//! `cargo test`. Heavy work (starting a child, probing over curl) happens in a
//! worker thread; every result is checked against a generation counter so a
//! slow answer for the profile the user just left cannot overwrite the one
//! they switched to.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::probe::Probe;
use crate::profiles::{
    self, entry_url, remove, to_public, upsert, validate_draft, Kind, Persisted, Profile,
    ProfileDraft, ShellState, Status, DETECTED_LOCAL_ID,
};

pub trait StoreLike: Send + Sync {
    fn save(&self, persisted: &Persisted) -> Result<(), String>;
}

pub trait GatewayHandle: Send + Sync {
    fn stop(&mut self);
}

pub struct StartedGateway {
    pub url: String,
    pub token: String,
    pub degraded: bool,
    pub detail: Option<String>,
    pub handle: Option<Box<dyn GatewayHandle>>,
}

pub type StartGatewayFn = Box<dyn Fn(&Profile) -> Result<StartedGateway, String> + Send + Sync>;
pub type ProbeFn = Box<dyn Fn(&str, Option<&str>) -> Probe + Send + Sync>;

pub struct Hooks {
    /// Start a managed local gateway. Never called for remote/unmanaged ones.
    pub start: StartGatewayFn,
    /// Probe one URL; the token is passed separately from the profile.
    pub probe: ProbeFn,
}

pub trait Notifier: Send + Sync {
    fn state(&self, state: &ShellState);
    fn navigate(&self, url: &str);
}

#[derive(Debug)]
pub struct ConnectTicket {
    pub generation: u64,
    pub profile: Profile,
}

pub enum ConnectResult {
    Online {
        profile_id: String,
        url: String,
        token: String,
        version: Option<String>,
        mode: Option<String>,
        degraded: bool,
        detail: Option<String>,
        handle: Option<Box<dyn GatewayHandle>>,
    },
    Offline {
        profile_id: String,
        url: Option<String>,
        error: String,
    },
}

pub struct Core {
    profiles: Vec<Profile>,
    active_profile_id: String,
    status: Status,
    generation: u64,
    supervisor: Option<Box<dyn GatewayHandle>>,
    store: Arc<dyn StoreLike>,
    notifier: Arc<dyn Notifier>,
    platform: String,
    app_version: String,
    last_entry_url: Option<String>,
    theme: String,
    locale: String,
}

fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("p-{}-{nanos}", std::process::id())
}

impl Core {
    pub fn new(
        persisted: Persisted,
        store: Arc<dyn StoreLike>,
        notifier: Arc<dyn Notifier>,
        platform: String,
        app_version: String,
    ) -> Self {
        let active_profile_id = persisted.active_profile_id.clone();
        Self {
            profiles: persisted.profiles,
            status: Status::idle(&active_profile_id),
            active_profile_id,
            generation: 0,
            supervisor: None,
            store,
            notifier,
            platform,
            app_version,
            last_entry_url: None,
            theme: persisted.theme,
            locale: persisted.locale,
        }
    }

    /// Adopt a gateway the user already started. The profile is persisted so
    /// the next launch can reconnect, but it stays unmanaged: if detection
    /// later fails, `fallback_from_detected` returns to the managed default.
    pub fn adopt_detected_local(&mut self, url: &str, token: &str) -> Result<(), String> {
        let url = profiles::normalize_url(url)?;
        let profile = Profile {
            id: DETECTED_LOCAL_ID.to_string(),
            label: crate::discovery::detected_label(&self.locale).to_string(),
            kind: Kind::Local,
            url,
            managed: false,
            token: Some(token.to_string()),
        };
        let previous = self.persisted();
        self.profiles = upsert(&self.profiles, profile);
        self.active_profile_id = DETECTED_LOCAL_ID.to_string();
        if let Err(error) = self.store.save(&self.persisted()) {
            self.profiles = previous.profiles;
            self.active_profile_id = previous.active_profile_id;
            return Err(format!("保存检测到的网关失败：{error}"));
        }
        self.emit();
        Ok(())
    }

    /// If the detected profile is active but nothing is listening any more,
    /// return to the managed local profile so the app can start its own.
    pub fn fallback_from_detected(&mut self) -> Result<bool, String> {
        if self.active_profile_id != DETECTED_LOCAL_ID {
            return Ok(false);
        }
        let Some(fallback) = self
            .profiles
            .iter()
            .find(|profile| profile.kind == Kind::Local && profile.managed)
            .or_else(|| self.profiles.first())
            .cloned()
        else {
            return Ok(false);
        };
        let previous_active = self.active_profile_id.clone();
        self.active_profile_id = fallback.id;
        if let Err(error) = self.store.save(&self.persisted()) {
            self.active_profile_id = previous_active;
            return Err(format!("保存网关设置失败：{error}"));
        }
        self.emit();
        Ok(true)
    }

    pub fn last_entry_url(&self) -> Option<&str> {
        self.last_entry_url.as_deref()
    }

    pub fn record_entry_url(&mut self, url: &str) {
        self.last_entry_url = Some(url.to_string());
    }

    /// Persist a presentation preference. Returns the rebuilt entry URL when a
    /// gateway is already live, so the caller can reload it with the new look.
    pub fn set_theme(&mut self, theme: &str) -> Result<Option<String>, String> {
        let theme = profiles::normalize_theme(theme);
        if theme == self.theme {
            return Ok(None);
        }
        let previous = self.theme.clone();
        self.theme = theme;
        if let Err(error) = self.store.save(&self.persisted()) {
            self.theme = previous;
            return Err(format!("保存外观设置失败：{error}"));
        }
        self.emit();
        self.rebuilt_entry_url()
    }

    pub fn set_locale(&mut self, locale: &str) -> Result<Option<String>, String> {
        let locale = profiles::normalize_locale(locale);
        if locale == self.locale {
            return Ok(None);
        }
        let previous = self.locale.clone();
        self.locale = locale;
        if let Err(error) = self.store.save(&self.persisted()) {
            self.locale = previous;
            return Err(format!("保存语言设置失败：{error}"));
        }
        self.emit();
        self.rebuilt_entry_url()
    }

    fn rebuilt_entry_url(&self) -> Result<Option<String>, String> {
        match self.last_entry_url.as_deref() {
            Some(url) => {
                profiles::with_preferences(url, &self.theme, &self.locale, &self.platform).map(Some)
            }
            None => Ok(None),
        }
    }

    pub fn state(&self) -> ShellState {
        ShellState {
            profiles: to_public(&self.profiles),
            active_profile_id: self.active_profile_id.clone(),
            status: self.status.clone(),
            theme: self.theme.clone(),
            locale: self.locale.clone(),
            platform: self.platform.clone(),
            app_version: self.app_version.clone(),
        }
    }

    fn persisted(&self) -> Persisted {
        Persisted {
            profiles: self.profiles.clone(),
            active_profile_id: self.active_profile_id.clone(),
            theme: self.theme.clone(),
            locale: self.locale.clone(),
        }
    }

    fn emit(&self) {
        self.notifier.state(&self.state());
    }

    pub fn save_profile(
        &mut self,
        draft: ProfileDraft,
    ) -> Result<(ShellState, Option<ConnectTicket>), String> {
        let existing = draft
            .id
            .as_ref()
            .and_then(|id| self.profiles.iter().find(|profile| &profile.id == id))
            .cloned();
        if draft.id.is_some() && existing.is_none() {
            return Err("网关不存在".into());
        }
        let id = draft.id.clone().unwrap_or_else(new_id);
        let profile = validate_draft(&draft, id, existing.as_ref())?;

        let previous = self.persisted();
        self.profiles = upsert(&self.profiles, profile.clone());
        if let Err(error) = self.store.save(&self.persisted()) {
            self.profiles = previous.profiles;
            return Err(format!("保存网关设置失败：{error}"));
        }
        let ticket = if self.active_profile_id == profile.id {
            self.begin_connect(&profile.id).ok().map(|(_, ticket)| ticket)
        } else {
            self.emit();
            None
        };
        Ok((self.state(), ticket))
    }

    pub fn remove_profile(
        &mut self,
        id: &str,
    ) -> Result<(ShellState, Option<ConnectTicket>), String> {
        let (profiles, active) = remove(&self.profiles, id, &self.active_profile_id)?;
        let previous = self.persisted();
        let active_removed = active != self.active_profile_id;
        self.profiles = profiles;
        self.active_profile_id = active.clone();
        if let Err(error) = self.store.save(&self.persisted()) {
            self.profiles = previous.profiles;
            self.active_profile_id = previous.active_profile_id;
            return Err(format!("删除网关失败：{error}"));
        }
        let ticket = if active_removed {
            self.begin_connect(&active).ok().map(|(_, ticket)| ticket)
        } else {
            self.emit();
            None
        };
        Ok((self.state(), ticket))
    }

    pub fn switch_profile(&mut self, id: &str) -> Result<(ShellState, ConnectTicket), String> {
        if !self.profiles.iter().any(|profile| profile.id == id) {
            return Err("网关不存在".into());
        }
        if self.active_profile_id != id {
            let previous = self.persisted();
            self.active_profile_id = id.to_string();
            if let Err(error) = self.store.save(&self.persisted()) {
                self.active_profile_id = previous.active_profile_id;
                return Err(format!("保存网关设置失败：{error}"));
            }
        }
        let (_, ticket) = self.begin_connect(id)?;
        Ok((self.state(), ticket))
    }

    pub fn restart(&mut self) -> Result<(ShellState, ConnectTicket), String> {
        let active = self.active_profile_id.clone();
        self.begin_connect(&active)
    }

    /// Stop the current gateway, enter `starting`, and hand the caller a
    /// ticket to run the blocking work for.
    pub fn begin_connect(&mut self, profile_id: &str) -> Result<(ShellState, ConnectTicket), String> {
        let profile = self
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
            .ok_or_else(|| "网关不存在".to_string())?;
        self.stop_supervisor();
        self.generation += 1;
        self.last_entry_url = None;
        let managed_local = profile.kind == Kind::Local && profile.managed;
        self.status = Status::starting(
            &profile.id,
            Some(if managed_local {
                "正在启动本机网关…".into()
            } else {
                "正在连接…".into()
            }),
        );
        self.emit();
        Ok((
            self.state(),
            ConnectTicket {
                generation: self.generation,
                profile,
            },
        ))
    }

    /// Apply a worker's result. Returns the URL the content webview should
    /// load, or `None` when the result is stale or offline.
    pub fn finish_connect(&mut self, generation: u64, result: ConnectResult) -> Option<String> {
        if generation != self.generation {
            if let ConnectResult::Online { handle, .. } = result {
                let mut handle = handle;
                if let Some(running) = handle.as_mut() {
                    running.stop();
                }
            }
            return None;
        }
        match result {
            ConnectResult::Online {
                profile_id,
                url,
                token,
                version,
                mode,
                degraded,
                detail,
                handle,
            } => {
                self.supervisor = handle;
                let mut status = Status::idle(&profile_id);
                status.state = "online".into();
                status.url = Some(url.clone());
                status.version = version;
                status.mode = mode;
                status.degraded = degraded;
                status.detail = detail;
                self.status = status;
                self.emit();
                match entry_url(&url, Some(&token))
                    .and_then(|entry| {
                    profiles::with_preferences(&entry, &self.theme, &self.locale, &self.platform)
                })
                {
                    Ok(entry) => {
                        self.last_entry_url = Some(entry.clone());
                        self.notifier.navigate(&entry);
                        Some(entry)
                    }
                    Err(_) => None,
                }
            }
            ConnectResult::Offline {
                profile_id,
                url,
                error,
            } => {
                let mut status = Status::idle(&profile_id);
                status.state = "offline".into();
                status.url = url;
                status.error = Some(error);
                self.status = status;
                self.emit();
                None
            }
        }
    }

    pub fn fail_startup(&mut self, generation: u64, profile_id: &str, error: String) {
        self.finish_connect(
            generation,
            ConnectResult::Offline {
                profile_id: profile_id.to_string(),
                url: None,
                error,
            },
        );
    }

    pub fn shutdown(&mut self) {
        self.generation += 1;
        self.stop_supervisor();
    }

    fn stop_supervisor(&mut self) {
        if let Some(mut running) = self.supervisor.take() {
            running.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{default_persisted, Kind, ProfileDraft};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorded {
        states: Vec<ShellState>,
        navigations: Vec<String>,
    }

    struct RecordingNotifier(Arc<Mutex<Recorded>>);

    impl Notifier for RecordingNotifier {
        fn state(&self, state: &ShellState) {
            self.0.lock().unwrap().states.push(state.clone());
        }
        fn navigate(&self, url: &str) {
            self.0.lock().unwrap().navigations.push(url.to_string());
        }
    }

    struct MemoryStore {
        saved: Mutex<Vec<Persisted>>,
        fail: AtomicUsize,
    }

    impl StoreLike for MemoryStore {
        fn save(&self, persisted: &Persisted) -> Result<(), String> {
            if self.fail.load(Ordering::SeqCst) > 0 {
                return Err("EACCES".into());
            }
            self.saved.lock().unwrap().push(persisted.clone());
            Ok(())
        }
    }

    struct RecordingHandle(Arc<AtomicUsize>);

    impl GatewayHandle for RecordingHandle {
        fn stop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct Harness {
        core: Core,
        notifier: Arc<Mutex<Recorded>>,
        store: Arc<MemoryStore>,
        stops: Arc<AtomicUsize>,
    }

    fn harness(probe_result: Probe) -> Harness {
        let notifier = Arc::new(Mutex::new(Recorded::default()));
        let store = Arc::new(MemoryStore {
            saved: Mutex::new(Vec::new()),
            fail: AtomicUsize::new(0),
        });
        let stops = Arc::new(AtomicUsize::new(0));
        let stops_for_start = Arc::clone(&stops);
        let probe = probe_result.clone();
        let hooks = Arc::new(Hooks {
            start: Box::new(move |_profile| {
                Ok(StartedGateway {
                    url: "http://127.0.0.1:5555".into(),
                    token: "local-token".into(),
                    degraded: false,
                    detail: None,
                    handle: Some(Box::new(RecordingHandle(Arc::clone(&stops_for_start)))),
                })
            }),
            probe: Box::new(move |_url, _token| probe.clone()),
        });
        let _ = hooks;
        let core = Core::new(
            default_persisted(),
            store.clone(),
            Arc::new(RecordingNotifier(Arc::clone(&notifier))),
            "darwin".into(),
            "0.0.1".into(),
        );
        Harness {
            core,
            notifier,
            store,
            stops,
        }
    }

    fn ticket(h: &mut Harness) -> (u64, Profile) {
        let (_, ticket) = h.core.begin_connect("local").unwrap();
        (ticket.generation, ticket.profile)
    }

    fn online() -> ConnectResult {
        ConnectResult::Online {
            profile_id: "local".into(),
            url: "http://127.0.0.1:5555".into(),
            token: "local-token".into(),
            version: Some("0.2.1".into()),
            mode: Some("local".into()),
            degraded: false,
            detail: None,
            handle: None,
        }
    }

    #[test]
    fn goes_online_and_navigates_with_the_token() {
        let mut h = harness(Probe::Online {
            version: None,
            mode: None,
        });
        let (generation, _) = ticket(&mut h);
        let entry = h.core.finish_connect(generation, online()).unwrap();
        assert_eq!(
            entry,
            "http://127.0.0.1:5555/?token=local-token&volto_shell=desktop&volto_theme=system&volto_locale=zh&volto_platform=darwin"
        );
        let state = h.core.state();
        assert_eq!(state.status.state, "online");
        assert_eq!(state.status.version.as_deref(), Some("0.2.1"));
        assert!(!serde_json::to_string(&state).unwrap().contains("local-token"));
        assert_eq!(
            h.notifier.lock().unwrap().navigations,
            vec![
                "http://127.0.0.1:5555/?token=local-token&volto_shell=desktop&volto_theme=system&volto_locale=zh&volto_platform=darwin"
                    .to_string()
            ]
        );
    }

    #[test]
    fn persists_presentation_preferences_and_rebuilds_the_entry_url() {
        let mut h = harness(Probe::Online {
            version: None,
            mode: None,
        });
        let (generation, _) = ticket(&mut h);
        h.core.finish_connect(generation, online());

        let rebuilt = h.core.set_theme("dark").unwrap().unwrap();
        assert!(rebuilt.contains("volto_theme=dark"));
        assert!(rebuilt.contains("volto_locale=zh"));
        assert!(rebuilt.contains("token=local-token"));
        assert_eq!(h.core.state().theme, "dark");
        assert_eq!(
            h.store.saved.lock().unwrap().last().unwrap().theme,
            "dark"
        );

        let rebuilt = h.core.set_locale("en").unwrap().unwrap();
        assert!(rebuilt.contains("volto_locale=en"));
        assert_eq!(h.core.state().locale, "en");
        assert!(h.core.set_locale("en").unwrap().is_none());
        assert!(h.core.set_theme("dark").unwrap().is_none());
        assert_eq!(h.store.saved.lock().unwrap().len(), 2);
    }

    #[test]
    fn goes_offline_without_navigating() {
        let mut h = harness(Probe::Offline {
            error: "无法连接网关".into(),
        });
        let (generation, _) = ticket(&mut h);
        let result = h.core.finish_connect(
            generation,
            ConnectResult::Offline {
                profile_id: "local".into(),
                url: Some("http://127.0.0.1:5555".into()),
                error: "无法连接网关".into(),
            },
        );
        assert!(result.is_none());
        assert!(h.notifier.lock().unwrap().navigations.is_empty());
        let state = h.core.state();
        assert_eq!(state.status.state, "offline");
        assert_eq!(state.status.error.as_deref(), Some("无法连接网关"));
    }

    #[test]
    fn drops_a_stale_result_and_stops_its_gateway() {
        let mut h = harness(Probe::Online {
            version: None,
            mode: None,
        });
        let (generation, _) = ticket(&mut h);
        let (_, _) = ticket(&mut h); // a second switch supersedes the first
        let handle = Box::new(RecordingHandle(Arc::clone(&h.stops)));
        let result = h.core.finish_connect(
            generation,
            ConnectResult::Online {
                profile_id: "local".into(),
                url: "http://127.0.0.1:5555".into(),
                token: "t".into(),
                version: None,
                mode: None,
                degraded: false,
                detail: None,
                handle: Some(handle),
            },
        );
        assert!(result.is_none());
        assert_eq!(h.stops.load(Ordering::SeqCst), 1);
        assert!(h.notifier.lock().unwrap().navigations.is_empty());
    }

    #[test]
    fn adopts_a_detected_local_gateway_and_falls_back() {
        let mut h = harness(Probe::Online {
            version: None,
            mode: None,
        });
        h.core
            .adopt_detected_local("http://127.0.0.1:3100/", "d".repeat(43).as_str())
            .unwrap();
        let state = h.core.state();
        assert_eq!(state.active_profile_id, DETECTED_LOCAL_ID);
        let detected = state
            .profiles
            .iter()
            .find(|profile| profile.id == DETECTED_LOCAL_ID)
            .unwrap();
        assert_eq!(detected.url, "http://127.0.0.1:3100");
        assert!(!detected.managed);
        assert!(detected.has_token);
        assert_eq!(
            h.store.saved.lock().unwrap().last().unwrap().active_profile_id,
            DETECTED_LOCAL_ID
        );

        assert!(h.core.fallback_from_detected().unwrap());
        assert_eq!(h.core.state().active_profile_id, "local");
    }

    #[test]
    fn rejects_an_invalid_draft_without_saving() {
        let mut h = harness(Probe::Online {
            version: None,
            mode: None,
        });
        let error = h
            .core
            .save_profile(ProfileDraft {
                id: None,
                label: " ".into(),
                kind: Kind::Remote,
                url: Some("https://gw".into()),
                token: None,
                managed: None,
            })
            .unwrap_err();
        assert_eq!(error, "名称不能为空");
        assert!(h.store.saved.lock().unwrap().is_empty());
    }

    #[test]
    fn reports_a_failed_write_and_keeps_the_previous_list() {
        let mut h = harness(Probe::Online {
            version: None,
            mode: None,
        });
        h.store.fail.store(1, Ordering::SeqCst);
        let error = h
            .core
            .save_profile(ProfileDraft {
                id: None,
                label: "New".into(),
                kind: Kind::Remote,
                url: Some("https://new.example.com".into()),
                token: None,
                managed: None,
            })
            .unwrap_err();
        assert_eq!(error, "保存网关设置失败：EACCES");
        assert_eq!(h.core.state().profiles.len(), 1);
    }

    #[test]
    fn saves_a_profile_and_reconnects_only_when_it_is_active() {
        let mut h = harness(Probe::Online {
            version: None,
            mode: None,
        });
        let (state, ticket) = h
            .core
            .save_profile(ProfileDraft {
                id: None,
                label: "Remote".into(),
                kind: Kind::Remote,
                url: Some("https://gw.example.com".into()),
                token: Some("tok".into()),
                managed: None,
            })
            .unwrap();
        assert_eq!(state.profiles.len(), 2);
        assert!(ticket.is_none());
        assert_eq!(h.store.saved.lock().unwrap().len(), 1);

        let (_, ticket) = h
            .core
            .save_profile(ProfileDraft {
                id: Some("local".into()),
                label: "本机".into(),
                kind: Kind::Local,
                url: None,
                token: None,
                managed: Some(true),
            })
            .unwrap();
        assert!(ticket.is_some());
    }

    #[test]
    fn refuses_to_remove_the_last_profile_and_reconnects_after_the_active_one() {
        let mut h = harness(Probe::Online {
            version: None,
            mode: None,
        });
        assert_eq!(h.core.remove_profile("local").unwrap_err(), "至少保留一个网关");

        h.core
            .save_profile(ProfileDraft {
                id: None,
                label: "Remote".into(),
                kind: Kind::Remote,
                url: Some("https://gw.example.com".into()),
                token: None,
                managed: None,
            })
            .unwrap();
        let (_, ticket) = h.core.begin_connect("local").unwrap();
        let remote_id = h.core.state().profiles[1].id.clone();
        h.core.switch_profile(&remote_id).unwrap();
        h.core.finish_connect(
            ticket.generation,
            ConnectResult::Offline {
                profile_id: "local".into(),
                url: None,
                error: "x".into(),
            },
        );
        let (_, ticket) = h.core.remove_profile(&remote_id).unwrap();
        assert!(ticket.is_some());
        assert_eq!(h.core.state().active_profile_id, "local");
    }

    #[test]
    fn switching_an_unknown_profile_is_an_error() {
        let mut h = harness(Probe::Online {
            version: None,
            mode: None,
        });
        assert_eq!(h.core.switch_profile("nope").unwrap_err(), "网关不存在");
    }

    #[test]
    fn shutdown_stops_the_current_gateway() {
        let mut h = harness(Probe::Online {
            version: None,
            mode: None,
        });
        let (generation, _) = ticket(&mut h);
        let handle = Box::new(RecordingHandle(Arc::clone(&h.stops)));
        h.core.finish_connect(
            generation,
            ConnectResult::Online {
                profile_id: "local".into(),
                url: "http://127.0.0.1:5555".into(),
                token: "t".into(),
                version: None,
                mode: None,
                degraded: false,
                detail: None,
                handle: Some(handle),
            },
        );
        h.core.shutdown();
        assert_eq!(h.stops.load(Ordering::SeqCst), 1);
    }
}