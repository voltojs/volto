#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod controller;
mod menu;
mod probe;
mod profiles;
mod runtime;
mod store;
mod supervisor;
mod windows;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::MenuId;
use tauri::{AppHandle, Manager, RunEvent, Wry};

use commands::AppState;
use profiles::ProfileDraft;
use store::ProfileStore;

fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::process::Command;
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        use std::process::Command;
        Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "pid="])
            .output()
            .map(|output| output.status.success() && !output.stdout.is_empty())
            .unwrap_or(false)
    }
}

/// One instance per config directory. A stale lock (crashed process) is taken
/// over instead of blocking startup forever.
fn acquire_instance_lock(dir: &Path) -> Option<PathBuf> {
    let _ = fs::create_dir_all(dir);
    let path = dir.join("instance.lock");
    for _ in 0..2 {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                let _ = write!(file, "{}", std::process::id());
                return Some(path);
            }
            Err(_) => {
                let pid = fs::read_to_string(&path)
                    .ok()
                    .and_then(|value| value.trim().parse::<u32>().ok());
                if pid.is_some_and(process_alive) {
                    return None;
                }
                let _ = fs::remove_file(&path);
            }
        }
    }
    None
}

fn handle_menu(app: &AppHandle<Wry>, id: &MenuId) {
    let id = id.as_ref();
    if id == menu::MANAGE_ID {
        let (locale, theme) = {
            let state = app.state::<AppState>();
            let snapshot = state.core.lock().unwrap().state();
            (snapshot.locale, snapshot.theme)
        };
        windows::open_settings(app, &locale, &theme);
        return;
    }
    if let Some(theme) = id.strip_prefix(menu::THEME_PREFIX) {
        if let Err(error) = commands::apply_theme(app, theme) {
            eprintln!("theme switch failed: {error}");
        }
        return;
    }
    if let Some(locale) = id.strip_prefix(menu::LOCALE_PREFIX) {
        if let Err(error) = commands::apply_locale(app, locale) {
            eprintln!("locale switch failed: {error}");
        }
        return;
    }
    if id == menu::RESTART_ID {
        commands::restart(app);
        return;
    }
    if id == menu::OPEN_BROWSER_ID {
        let state = app.state::<AppState>();
        let url = state
            .core
            .lock()
            .unwrap()
            .last_entry_url()
            .map(str::to_string);
        if let Some(url) = url {
            windows::open_external(&url);
        }
        return;
    }
    if id == menu::RELOAD_ID {
        app.state::<AppState>().windows.reload();
        return;
    }
    #[cfg(debug_assertions)]
    if id == menu::DEVTOOLS_ID {
        if let Some(main) = app.get_webview_window("main") {
            main.open_devtools();
        }
        return;
    }
    if let Some(profile_id) = id.strip_prefix(menu::PROFILE_PREFIX) {
        commands::switch_to(app, profile_id);
    }
}

fn setup(app: &mut tauri::App<Wry>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    // Smoke runs own their config directory so they never read or mutate the
    // real profile list, and repeated runs start clean.
    let config_dir = match commands::smoke_output_dir() {
        Some(dir) => dir.join("user-data"),
        None => app.path().app_config_dir()?,
    };
    let Some(lock_path) = acquire_instance_lock(&config_dir) else {
        eprintln!("another Volto Desktop instance already owns {config_dir:?}");
        handle.exit(0);
        return Ok(());
    };

    let main_windows = windows::create(&handle)?;
    let store = Arc::new(ProfileStore::new(&config_dir));
    let persisted = store.load();
    let resource_dir = app.path().resource_dir().ok();
    let hooks = Arc::new(commands::build_hooks(resource_dir));
    let core = commands::build_core(
        &handle,
        &main_windows,
        persisted,
        store,
        app.package_info().version.to_string(),
    );
    app.manage(AppState {
        core,
        hooks,
        windows: main_windows,
        ui_report: Arc::new(Mutex::new(None)),
        page_report: Arc::new(Mutex::new(None)),
        lock_path: Some(lock_path),
    });

    // Smoke runs may pin the presentation before connecting, so the entry URL
    // and the settings page carry it.
    {
        let state = app.state::<AppState>();
        if let Ok(theme) = std::env::var("VOLTO_DESKTOP_SMOKE_THEME") {
            let _ = state.core.lock().unwrap().set_theme(&theme);
        }
        if let Ok(locale) = std::env::var("VOLTO_DESKTOP_SMOKE_LOCALE") {
            let _ = state.core.lock().unwrap().set_locale(&locale);
        }
    }

    let initial_state = app.state::<AppState>().core.lock().unwrap().state();
    app.set_menu(menu::build_menu(&handle, &initial_state)?)?;

    if let Ok(raw) = std::env::var("VOLTO_DESKTOP_SMOKE_PROFILE") {
        match serde_json::from_str::<ProfileDraft>(&raw) {
            Ok(draft) => {
                let label = draft.label.clone();
                let state = app.state::<AppState>();
                if let Err(error) = state.core.lock().unwrap().save_profile(draft) {
                    eprintln!("smoke profile rejected: {error}");
                }
                let id = state
                    .core
                    .lock()
                    .unwrap()
                    .state()
                    .profiles
                    .iter()
                    .find(|profile| profile.label == label)
                    .map(|profile| profile.id.clone());
                if let Some(id) = id {
                    let switched = {
                        let mut core = state.core.lock().unwrap();
                        core.switch_profile(&id)
                    };
                    match switched {
                        Ok((_, ticket)) => commands::spawn_connect(handle.clone(), ticket),
                        Err(error) => eprintln!("smoke switch failed: {error}"),
                    }
                }
            }
            Err(error) => eprintln!("invalid VOLTO_DESKTOP_SMOKE_PROFILE: {error}"),
        }
    } else {
        let started = {
            let state = app.state::<AppState>();
            let mut core = state.core.lock().unwrap();
            core.begin_connect(&initial_state.active_profile_id)
        };
        match started {
            Ok((_, ticket)) => commands::spawn_connect(handle.clone(), ticket),
            Err(error) => eprintln!("initial connect failed: {error}"),
        }
    }

    if let Some(dir) = commands::smoke_output_dir() {
        let thread_handle = handle.clone();
        std::thread::spawn(move || {
            let path = dir.join("smoke.json");
            let status = {
                let state = thread_handle.state::<AppState>();
                let status = commands::wait_for_terminal(&state, Duration::from_secs(45));
                let wants_settings = std::env::var("VOLTO_DESKTOP_SMOKE_SETTINGS")
                    .or_else(|_| std::env::var("VOLTO_DESKTOP_SMOKE_SHEET"))
                    .as_deref()
                    == Ok("1");
                if wants_settings {
                    let (locale, theme) = {
                        let state = thread_handle.state::<AppState>();
                        let snapshot = state.core.lock().unwrap().state();
                        (snapshot.locale, snapshot.theme)
                    };
                    windows::open_settings(&thread_handle, &locale, &theme);
                    std::thread::sleep(Duration::from_millis(600));
                }
                if std::env::var("VOLTO_DESKTOP_SMOKE_TOGGLE").as_deref() == Ok("1") {
                    // Go through the same handler the native menu calls, so
                    // the toggle smoke covers the `theme:`/`locale:` dispatch
                    // and not only the apply functions.
                    handle_menu(
                        &thread_handle,
                        &MenuId(format!("{}{}", menu::THEME_PREFIX, "light")),
                    );
                    handle_menu(
                        &thread_handle,
                        &MenuId(format!("{}{}", menu::LOCALE_PREFIX, "zh")),
                    );
                    std::thread::sleep(Duration::from_millis(1200));
                }
                if let Err(error) = commands::write_smoke(&thread_handle, &state, &path) {
                    eprintln!("smoke: {error}");
                }
                status
            };
            eprintln!("smoke: status={} written={}", status.state, path.display());
            thread_handle.exit(0);
        });
    }

    Ok(())
}

fn main() {
    #[cfg(unix)]
    supervisor::install_signal_guard();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::save_profile,
            commands::remove_profile,
            commands::switch_profile,
            commands::restart_gateway,
            commands::retry_gateway,
            commands::reload,
            commands::open_in_browser,
            commands::open_settings,
            commands::close_settings,
            commands::set_theme,
            commands::set_locale,
            commands::report_ui,
        ])
        .on_menu_event(|app, event| handle_menu(app, event.id()))
        .setup(|app| {
            setup(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Volto Desktop")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state = app.state::<AppState>();
                state.core.lock().unwrap().shutdown();
                if let Some(path) = &state.lock_path {
                    let _ = fs::remove_file(path);
                }
            }
        });
}