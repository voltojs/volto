//! Single-webview window management.
//!
//! The main window always shows either the active gateway's own UI or a local
//! static page ("connecting" / "offline") — never our React app. The settings
//! window is a separate local webview and the only one with IPC access. This
//! keeps the gateway page at its own origin with its own cookies, and keeps
//! desktop privileges out of remote content.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};

pub const CONNECTING_PAGE: &str = "connecting.html";
pub const OFFLINE_PAGE: &str = "offline.html";
pub const CONNECTING_EN_PAGE: &str = "connecting.en.html";
pub const OFFLINE_EN_PAGE: &str = "offline.en.html";

#[derive(Clone)]
pub struct Windows {
    pub main: WebviewWindow<Wry>,
    pub app_origin: String,
    pub gateway_origin: Arc<Mutex<Option<String>>>,
    /// The URL we asked the main window to show. `WebviewWindow::url()` panics
    /// inside wry while no navigation has committed yet, so never query it.
    current_url: Arc<Mutex<Option<String>>>,
}

/// Origin for http(s); scheme+host for the app's custom protocol, whose
/// `Url::origin()` is opaque ("null") and would never match itself.
pub fn origin_of(url: &Url) -> String {
    if matches!(url.scheme(), "http" | "https") {
        url.origin().ascii_serialization()
    } else {
        format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default())
    }
}

fn is_external(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

pub fn open_external(url: &str) {
    let command = if cfg!(windows) {
        "cmd"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut process = std::process::Command::new(command);
    if cfg!(windows) {
        process.args(["/C", "start", ""]).arg(url);
    } else {
        process.arg(url);
    }
    let _ = process.spawn();
}

impl Windows {
    /// Point the main window at a local static page and forget the gateway
    /// origin it used to allow.
    pub fn show_page(&self, page: &str) {
        *self.gateway_origin.lock().unwrap() = None;
        let url = format!("{}/{}", self.app_origin.trim_end_matches('/'), page);
        *self.current_url.lock().unwrap() = Some(url.clone());
        if let Ok(parsed) = Url::parse(&url) {
            let _ = self.main.navigate(parsed);
        }
    }

    pub fn current_url(&self) -> Option<String> {
        self.current_url.lock().unwrap().clone()
    }

    pub fn navigate_gateway(&self, url: &str) -> Result<(), String> {
        let parsed = Url::parse(url).map_err(|error| error.to_string())?;
        *self.gateway_origin.lock().unwrap() = Some(origin_of(&parsed));
        *self.current_url.lock().unwrap() = Some(url.to_string());
        self.main
            .navigate(parsed)
            .map_err(|error| error.to_string())
    }

    pub fn reload(&self) {
        let target = self.current_url.lock().unwrap().clone();
        if let Some(url) = target.and_then(|value| Url::parse(&value).ok()) {
            let _ = self.main.navigate(url);
        }
    }

    pub fn set_title(&self, title: &str) {
        let _ = self.main.set_title(title);
    }
}

/// Where `WebviewUrl::App` resolves: the Vite dev server during `tauri dev`,
/// the embedded assets otherwise. Computed, never read back from the webview.
fn configured_app_origin(app: &AppHandle<Wry>) -> String {
    if tauri::is_dev() {
        if let Some(dev) = app.config().build.dev_url.clone() {
            return origin_of(&dev);
        }
    }
    if cfg!(windows) {
        "http://tauri.localhost".to_string()
    } else {
        "tauri://localhost".to_string()
    }
}

pub fn create(app: &AppHandle<Wry>) -> tauri::Result<Windows> {
    let app_origin: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let gateway_origin: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let policy_app = Arc::clone(&app_origin);
    let policy_gateway = Arc::clone(&gateway_origin);

    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(CONNECTING_PAGE.into()))
        .title("Volto Desktop")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0);
    // The traffic lights float over the web UI so the right pane can use the
    // full height; the web sidebar reserves their corner.
    #[cfg(target_os = "macos")]
    {
        // Do not override trafficLightPosition: a custom inset makes the
        // controls transparent while the window is inactive. Native placement
        // keeps them visible and still lands inside the sidebar's top strip.
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    let main = builder
        .on_navigation(move |url| {
            if url.as_str() == "about:blank" {
                return true;
            }
            let app_ok = policy_app
                .lock()
                .unwrap()
                .as_deref()
                .is_some_and(|origin| origin == origin_of(url));
            let gateway_ok = policy_gateway
                .lock()
                .unwrap()
                .as_deref()
                .is_some_and(|origin| origin == origin_of(url));
            let allowed = app_ok || gateway_ok;
            if !allowed && is_external(url) {
                open_external(url.as_str());
            }
            allowed
        })
        .build()?;

    let origin = configured_app_origin(app);
    *app_origin.lock().unwrap() = Some(origin.clone());
    Ok(Windows {
        main,
        app_origin: origin,
        gateway_origin,
        current_url: Arc::new(Mutex::new(None)),
    })
}

/// Open (or focus) the local settings window. It renders the React app and is
/// the only webview allowed to call commands.
///
/// Window creation must happen on the main thread: calling it from a worker
/// thread (the connect worker emits state) crashes inside wry.
pub fn open_settings(app: &AppHandle<Wry>, locale: &str, theme: &str) {
    let handle = app.clone();
    let locale = locale.to_string();
    let theme = theme.to_string();
    let _ = app.run_on_main_thread(move || open_settings_on_main(&handle, &locale, &theme));
}

pub fn settings_title(locale: &str) -> &'static str {
    if locale == crate::profiles::LOCALE_EN {
        "Gateway Settings"
    } else {
        "网关设置"
    }
}

fn native_theme(theme: &str) -> Option<tauri::Theme> {
    match theme {
        crate::profiles::THEME_LIGHT => Some(tauri::Theme::Light),
        crate::profiles::THEME_DARK => Some(tauri::Theme::Dark),
        _ => None,
    }
}

/// Keep an open settings window's native chrome and title in step with the
/// preference, without recreating it.
pub fn apply_settings_appearance(app: &AppHandle<Wry>, locale: &str, theme: &str) {
    let handle = app.clone();
    let locale = locale.to_string();
    let theme = theme.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("settings") {
            let _ = window.set_title(settings_title(&locale));
            let _ = window.set_theme(native_theme(&theme));
        }
    });
}

fn open_settings_on_main(app: &AppHandle<Wry>, locale: &str, theme: &str) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_title(settings_title(locale));
        let _ = window.set_theme(native_theme(theme));
        let _ = window.set_focus();
        return;
    }
    // Never read the main window's URL here: it may be the gateway, and the
    // settings window must be allowed only on the app's own origin.
    let app_origin = configured_app_origin(app);
    let boot = serde_json::json!({ "theme": theme, "locale": locale });
    let boot_script = format!(
        "window.__VOLTO_SURFACE__ = 'settings'; window.__VOLTO_BOOT__ = {boot};"
    );
    let builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title(settings_title(locale))
        .inner_size(780.0, 720.0)
        .min_inner_size(560.0, 420.0)
        .theme(native_theme(theme))
        .initialization_script(boot_script)
        .on_page_load(|_window, payload| {
            eprintln!("settings: page load {}", payload.url());
        })
        .on_navigation(move |url| {
            url.as_str() == "about:blank" || origin_of(url) == app_origin
        });
    let _ = builder.build();
}

pub fn close_settings(app: &AppHandle<Wry>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("settings") {
            let _ = window.close();
        }
    });
}
