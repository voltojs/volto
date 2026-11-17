//! Tauri commands and the worker that performs the blocking part of a switch.
//!
//! Only the local `settings` webview may call commands; the main window shows
//! the gateway's own UI (or a static local page), so it has no bridge at all.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, Webview, Wry};

use crate::controller::{ConnectResult, ConnectTicket, Core, Hooks, Notifier, StartedGateway};
use crate::menu;
use crate::probe::Probe;
use crate::profiles::{Kind, Profile, ProfileDraft, ShellState, Status};
use crate::runtime;
use crate::supervisor;
use crate::windows::{self, Windows};

pub struct AppState {
    pub core: Arc<Mutex<Core>>,
    pub hooks: Arc<Hooks>,
    pub windows: Windows,
    pub ui_report: Arc<Mutex<Option<Value>>>,
    pub page_report: Arc<Mutex<Option<Value>>>,
    pub lock_path: Option<PathBuf>,
}

pub fn is_settings_label(label: &str) -> bool {
    label == "settings"
}

fn ensure_settings(webview: &Webview<Wry>) -> Result<(), String> {
    if is_settings_label(webview.label()) {
        Ok(())
    } else {
        Err("不受信任的调用方".into())
    }
}

fn title_for(state: &ShellState) -> String {
    let label = state
        .profiles
        .iter()
        .find(|profile| profile.id == state.active_profile_id)
        .map(|profile| profile.label.as_str())
        .unwrap_or("Volto");
    let en = state.locale == crate::profiles::LOCALE_EN;
    let status = match state.status.state.as_str() {
        "online" => if en { "Connected" } else { "已连接" },
        "starting" => if en { "Connecting…" } else { "连接中…" },
        "offline" => if en { "Offline" } else { "未连接" },
        _ => if en { "Ready" } else { "准备中" },
    };
    format!("Volto Desktop · {label} · {status}")
}

struct AppNotifier {
    app: AppHandle<Wry>,
    windows: Windows,
}

impl Notifier for AppNotifier {
    fn state(&self, state: &ShellState) {
        let _ = self.app.emit("shell:state", state);
        self.windows.set_title(&title_for(state));
        let en = state.locale == crate::profiles::LOCALE_EN;
        match state.status.state.as_str() {
            "starting" => self.windows.show_page(page_for(windows::CONNECTING_PAGE, en)),
            "offline" => {
                self.windows.show_page(page_for(windows::OFFLINE_PAGE, en));
                windows::open_settings(&self.app, &state.locale, &state.theme);
            }
            _ => {}
        }
        windows::apply_settings_appearance(&self.app, &state.locale, &state.theme);
        if let Ok(menu) = menu::build_menu(&self.app, state) {
            let _ = self.app.set_menu(menu);
        }
    }

    fn navigate(&self, url: &str) {
        let _ = self.windows.navigate_gateway(url);
    }
}

fn page_for(base: &str, english: bool) -> &'static str {
    if !english {
        return match base {
            windows::CONNECTING_PAGE => windows::CONNECTING_PAGE,
            _ => windows::OFFLINE_PAGE,
        };
    }
    match base {
        windows::CONNECTING_PAGE => windows::CONNECTING_EN_PAGE,
        _ => windows::OFFLINE_EN_PAGE,
    }
}

pub fn build_hooks(resource_dir: Option<PathBuf>) -> Hooks {
    Hooks {
        start: Box::new(move |profile: &Profile| {
            let resolved = runtime::resolve_runtime(resource_dir.as_deref())?;
            let running = supervisor::start(
                &resolved.node,
                &resolved.entry,
                profile,
                Duration::from_secs(30),
            )?;
            let degraded = running.degraded;
            Ok(StartedGateway {
                url: running.url.clone(),
                token: running.token.clone(),
                degraded,
                detail: degraded.then(|| {
                    "本机网关的 SQLite 会话库不可用，已回退到文件存储（运行 volto doctor 查看）"
                        .to_string()
                }),
                handle: Some(Box::new(running)),
            })
        }),
        probe: Box::new(|url: &str, token: Option<&str>| crate::probe::probe(url, token)),
    }
}

pub fn build_core(
    app: &AppHandle<Wry>,
    windows: &Windows,
    persisted: crate::profiles::Persisted,
    store: Arc<dyn crate::controller::StoreLike>,
    app_version: String,
) -> Arc<Mutex<Core>> {
    let notifier = Arc::new(AppNotifier {
        app: app.clone(),
        windows: windows.clone(),
    });
    Arc::new(Mutex::new(Core::new(
        persisted,
        store,
        notifier,
        platform_name(),
        app_version,
    )))
}

pub fn platform_name() -> String {
    if cfg!(target_os = "macos") {
        "darwin".into()
    } else if cfg!(windows) {
        "win32".into()
    } else {
        "linux".into()
    }
}

pub fn spawn_connect(app: AppHandle<Wry>, ticket: ConnectTicket) {
    std::thread::spawn(move || {
        let managed_state = app.state::<AppState>();
        let core = Arc::clone(&managed_state.core);
        let hooks = Arc::clone(&managed_state.hooks);
        let profile = ticket.profile.clone();
        let managed_local = profile.kind == Kind::Local && profile.managed;
        let result = if managed_local {
            match (hooks.start)(&profile) {
                Ok(mut started) => match (hooks.probe)(&started.url, Some(&started.token)) {
                    Probe::Online { version, mode } => ConnectResult::Online {
                        profile_id: profile.id.clone(),
                        url: started.url,
                        token: started.token,
                        version,
                        mode,
                        degraded: started.degraded,
                        detail: started.detail,
                        handle: started.handle.take(),
                    },
                    Probe::Offline { error } => {
                        if let Some(handle) = started.handle.as_mut() {
                            handle.stop();
                        }
                        ConnectResult::Offline {
                            profile_id: profile.id.clone(),
                            url: Some(started.url),
                            error,
                        }
                    }
                },
                Err(error) => {
                    core.lock()
                        .unwrap()
                        .fail_startup(ticket.generation, &profile.id, error);
                    return;
                }
            }
        } else {
            match (hooks.probe)(&profile.url, profile.token.as_deref()) {
                Probe::Online { version, mode } => ConnectResult::Online {
                    profile_id: profile.id.clone(),
                    url: profile.url.clone(),
                    token: profile.token.clone().unwrap_or_default(),
                    version,
                    mode,
                    degraded: false,
                    detail: None,
                    handle: None,
                },
                Probe::Offline { error } => ConnectResult::Offline {
                    profile_id: profile.id.clone(),
                    url: Some(profile.url.clone()),
                    error,
                },
            }
        };
        core.lock()
            .unwrap()
            .finish_connect(ticket.generation, result);
    });
}

pub fn switch_to(app: &AppHandle<Wry>, id: &str) {
    let ticket = {
        let state = app.state::<AppState>();
        let mut core = state.core.lock().unwrap();
        match core.switch_profile(id) {
            Ok((_, ticket)) => ticket,
            Err(error) => {
                eprintln!("switch failed: {error}");
                return;
            }
        }
    };
    spawn_connect(app.clone(), ticket);
}

pub fn restart(app: &AppHandle<Wry>) {
    let ticket = {
        let state = app.state::<AppState>();
        let mut core = state.core.lock().unwrap();
        match core.restart() {
            Ok((_, ticket)) => ticket,
            Err(error) => {
                eprintln!("restart failed: {error}");
                return;
            }
        }
    };
    spawn_connect(app.clone(), ticket);
}

#[tauri::command]
pub fn get_state(webview: Webview<Wry>, state: State<'_, AppState>) -> Result<ShellState, String> {
    ensure_settings(&webview)?;
    Ok(state.core.lock().unwrap().state())
}

#[tauri::command]
pub fn save_profile(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    state: State<'_, AppState>,
    draft: ProfileDraft,
) -> Result<ShellState, String> {
    ensure_settings(&webview)?;
    let ticket = state.core.lock().unwrap().save_profile(draft)?.1;
    if let Some(ticket) = ticket {
        spawn_connect(app, ticket);
    }
    Ok(state.core.lock().unwrap().state())
}

#[tauri::command]
pub fn remove_profile(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    state: State<'_, AppState>,
    id: String,
) -> Result<ShellState, String> {
    ensure_settings(&webview)?;
    let ticket = state.core.lock().unwrap().remove_profile(&id)?.1;
    if let Some(ticket) = ticket {
        spawn_connect(app, ticket);
    }
    Ok(state.core.lock().unwrap().state())
}

#[tauri::command]
pub fn switch_profile(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    ensure_settings(&webview)?;
    let ticket = state.core.lock().unwrap().switch_profile(&id)?.1;
    spawn_connect(app, ticket);
    Ok(())
}

#[tauri::command]
pub fn restart_gateway(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ensure_settings(&webview)?;
    let ticket = state.core.lock().unwrap().restart()?.1;
    spawn_connect(app, ticket);
    Ok(())
}

#[tauri::command]
pub fn retry_gateway(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    restart_gateway(app, webview, state)
}

#[tauri::command]
pub fn reload(webview: Webview<Wry>, state: State<'_, AppState>) -> Result<(), String> {
    ensure_settings(&webview)?;
    state.windows.reload();
    Ok(())
}

#[tauri::command]
pub fn open_in_browser(webview: Webview<Wry>, state: State<'_, AppState>) -> Result<(), String> {
    ensure_settings(&webview)?;
    let url = state
        .core
        .lock()
        .unwrap()
        .last_entry_url()
        .map(str::to_string);
    if let Some(url) = url {
        windows::open_external(&url);
    }
    Ok(())
}

#[tauri::command]
pub fn open_settings(app: AppHandle<Wry>, webview: Webview<Wry>) -> Result<(), String> {
    ensure_settings(&webview)?;
    let (locale, theme) = {
        let state = app.state::<AppState>();
        let snapshot = state.core.lock().unwrap().state();
        (snapshot.locale, snapshot.theme)
    };
    windows::open_settings(&app, &locale, &theme);
    Ok(())
}

#[tauri::command]
pub fn set_theme(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    theme: String,
) -> Result<(), String> {
    ensure_settings(&webview)?;
    apply_theme(&app, &theme)
}

#[tauri::command]
pub fn set_locale(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    locale: String,
) -> Result<(), String> {
    ensure_settings(&webview)?;
    apply_locale(&app, &locale)
}

/// Apply a presentation switch from the settings window or the native menu.
pub fn apply_theme(app: &AppHandle<Wry>, theme: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let next = state.core.lock().unwrap().set_theme(theme)?;
    if let Some(url) = next {
        state.core.lock().unwrap().record_entry_url(&url);
        state.windows.navigate_gateway(&url)?;
    }
    let snapshot = state.core.lock().unwrap().state();
    windows::apply_settings_appearance(app, &snapshot.locale, &snapshot.theme);
    Ok(())
}

pub fn apply_locale(app: &AppHandle<Wry>, locale: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let next = state.core.lock().unwrap().set_locale(locale)?;
    if let Some(url) = next {
        state.core.lock().unwrap().record_entry_url(&url);
        state.windows.navigate_gateway(&url)?;
    }
    let snapshot = state.core.lock().unwrap().state();
    windows::apply_settings_appearance(app, &snapshot.locale, &snapshot.theme);
    Ok(())
}

#[tauri::command]
pub fn close_settings(app: AppHandle<Wry>, webview: Webview<Wry>) -> Result<(), String> {
    ensure_settings(&webview)?;
    windows::close_settings(&app);
    Ok(())
}

#[tauri::command]
pub fn report_ui(
    webview: Webview<Wry>,
    state: State<'_, AppState>,
    report: Value,
) -> Result<(), String> {
    ensure_settings(&webview)?;
    *state.ui_report.lock().unwrap() = Some(report);
    Ok(())
}

/// Never write a launch token into an artifact.
fn redact_url(value: &str) -> String {
    match url::Url::parse(value) {
        Ok(mut parsed) => {
            let pairs: Vec<(String, String)> = parsed
                .query_pairs()
                .map(|(key, value)| {
                    let value = if key == "token" {
                        "redacted".to_string()
                    } else {
                        value.into_owned()
                    };
                    (key.into_owned(), value)
                })
                .collect();
            parsed.set_query(None);
            if !pairs.is_empty() {
                let mut query = parsed.query_pairs_mut();
                for (key, value) in pairs {
                    query.append_pair(&key, &value);
                }
            }
            parsed.to_string()
        }
        Err(_) => value.to_string(),
    }
}

pub fn smoke_context(app: &AppHandle<Wry>, state: &AppState) -> Value {
    let snapshot = state.core.lock().unwrap().state();
    let main_url = redact_url(&state.windows.current_url().unwrap_or_default());
    let main_title = state.windows.main.title().unwrap_or_default();
    let settings_window = app.get_webview_window("settings");
    let settings_url = if settings_window.is_some() {
        format!("{}/index.html", state.windows.app_origin.trim_end_matches('/'))
    } else {
        String::new()
    };
    let settings_title = settings_window
        .as_ref()
        .and_then(|window| window.title().ok())
        .unwrap_or_default();
    let ui_report = state.ui_report.lock().unwrap().clone();
    let page_report = state.page_report.lock().unwrap().clone();
    json!({
        "status": snapshot.status,
        "theme": snapshot.theme,
        "locale": snapshot.locale,
        "profiles": snapshot.profiles,
        "activeProfileId": snapshot.active_profile_id,
        "appVersion": snapshot.app_version,
        "mainUrl": main_url,
        "mainTitle": main_title,
        "settingsUrl": settings_url,
        "settingsTitle": settings_title,
        "uiReport": ui_report,
        "pageReport": page_report,
    })
}

pub fn smoke_output_dir() -> Option<PathBuf> {
    std::env::var("VOLTO_DESKTOP_SMOKE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn wait_for_terminal(state: &AppState, timeout: Duration) -> Status {
    let started = SystemTime::now();
    loop {
        let status = state.core.lock().unwrap().state().status;
        if status.state == "online" || status.state == "offline" {
            return status;
        }
        if started.elapsed().map(|elapsed| elapsed > timeout).unwrap_or(true) {
            return status;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Ask the gateway webview what the web app booted with. `eval_with_callback`
/// uses the platform's native evaluation (no IPC bridge in the main webview),
/// so this is the only way to prove the desktop layout flag and theme landed.
fn request_page_report(app: &AppHandle<Wry>, state: &AppState) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let store = Arc::clone(&state.page_report);
    let script = r#"
      (() => {
        try {
          const root = document.documentElement;
          const header = document.querySelector("header");
          const strip = document.querySelector(".desktop-traffic-strip");
          return {
            ready: Boolean(header),
            title: document.title,
            lang: root.lang,
            theme: root.dataset.voltoTheme ?? null,
            shell: root.dataset.voltoShell ?? null,
            dark: root.classList.contains("dark"),
            fullscreen: root.hasAttribute("data-volto-fullscreen"),
            internals: Boolean(window.__TAURI_INTERNALS__),
            dragRegions: document.querySelectorAll("[data-tauri-drag-region]").length,
            stripHeight: strip ? strip.getBoundingClientRect().height : 0,
            headerPad: header ? getComputedStyle(header).paddingLeft : null,
            text: (document.body?.innerText ?? "").slice(0, 160),
          };
        } catch (error) {
          return { error: String(error) };
        }
      })()
    "#;
    let _ = main.eval_with_callback(script, move |result| {
        let parsed = serde_json::from_str::<Value>(&result).ok();
        *store.lock().unwrap() = parsed;
    });
}

pub fn write_smoke(app: &AppHandle<Wry>, state: &AppState, path: &std::path::Path) -> std::io::Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    while std::time::Instant::now() < deadline {
        request_page_report(app, state);
        std::thread::sleep(Duration::from_millis(200));
        let ready = state
            .page_report
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|value| value.get("ready"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if ready {
            break;
        }
    }
    if std::env::var("VOLTO_DESKTOP_SMOKE_FULLSCREEN_ATTR").as_deref() == Ok("1") {
        // Native fullscreen cannot be held while the app is launched in the
        // background; set the marker on the settled page to verify the CSS.
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.eval(
                "document.documentElement.setAttribute('data-volto-fullscreen','true')",
            );
        }
        std::thread::sleep(Duration::from_millis(300));
        request_page_report(app, state);
        std::thread::sleep(Duration::from_millis(300));
    }
    // The settings page reports itself after mounting; wait for a non-empty
    // report instead of racing it with an eval.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let ready = state
            .ui_report
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|value| value.get("text"))
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty());
        if ready || std::time::Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let value = smoke_context(app, state);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&value).unwrap_or_default()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_only_the_token() {
        let url = redact_url(
            "http://127.0.0.1:3000/?token=secret&volto_shell=desktop&volto_theme=dark&volto_locale=en",
        );
        assert!(!url.contains("secret"));
        assert!(url.contains("token=redacted"));
        assert!(url.contains("volto_shell=desktop"));
        assert!(url.contains("volto_theme=dark"));
        assert!(url.contains("volto_locale=en"));
    }

    #[test]
    fn only_the_settings_webview_is_trusted() {
        assert!(is_settings_label("settings"));
        assert!(!is_settings_label("main"));
        assert!(!is_settings_label(""));
    }
}