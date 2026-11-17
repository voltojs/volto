//! Native application menu. The Gateway submenu mirrors the profile list, so
//! the app stays switchable when the settings window is closed, and it is the
//! discoverable path to that window (Cmd/Ctrl+Shift+G). The View menu carries
//! the presentation switches: theme and language.
//!
//! The model is a plain data structure so the shape (labels, ids, checked
//! radio, enabled state) is testable without Tauri.

use tauri::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Wry};

use crate::profiles::{self, ShellState};

pub const MANAGE_ID: &str = "manage";
pub const RESTART_ID: &str = "restart";
pub const OPEN_BROWSER_ID: &str = "open-browser";
pub const RELOAD_ID: &str = "reload";
#[cfg(debug_assertions)]
pub const DEVTOOLS_ID: &str = "devtools";
pub const PROFILE_PREFIX: &str = "profile:";
pub const THEME_PREFIX: &str = "theme:";
pub const LOCALE_PREFIX: &str = "locale:";

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayMenuModel {
    pub profiles: Vec<(String, String, bool)>,
    pub manage_accelerator: String,
    pub open_browser_enabled: bool,
    pub checked_theme: String,
    pub checked_locale: String,
}

/// Every string the menu renders. Kept separate from the Tauri builder so both
/// languages are pinned by a test rather than by reading native menus.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuText {
    pub about: String,
    pub quit: String,
    pub edit: String,
    pub undo: String,
    pub redo: String,
    pub cut: String,
    pub copy: String,
    pub paste: String,
    pub select_all: String,
    pub view: String,
    pub reload: String,
    pub theme: String,
    pub theme_system: String,
    pub theme_light: String,
    pub theme_dark: String,
    pub language: String,
    pub language_zh: String,
    pub language_en: String,
    pub fullscreen: String,
    pub devtools: String,
    pub gateway: String,
    pub manage: String,
    pub restart: String,
    pub open_browser: String,
    pub window: String,
    pub minimize: String,
    pub close_window: String,
}

pub fn menu_text(locale: &str) -> MenuText {
    let en = locale == profiles::LOCALE_EN;
    let pick = |zh: &str, english: &str| if en { english } else { zh }.to_string();
    MenuText {
        about: pick("关于 Volto Desktop", "About Volto Desktop"),
        quit: pick("退出 Volto Desktop", "Quit Volto Desktop"),
        edit: pick("编辑", "Edit"),
        undo: pick("撤销", "Undo"),
        redo: pick("重做", "Redo"),
        cut: pick("剪切", "Cut"),
        copy: pick("复制", "Copy"),
        paste: pick("粘贴", "Paste"),
        select_all: pick("全选", "Select All"),
        view: pick("视图", "View"),
        reload: pick("重新加载界面", "Reload Interface"),
        theme: pick("主题", "Theme"),
        theme_system: pick("跟随系统", "System"),
        theme_light: pick("浅色", "Light"),
        theme_dark: pick("深色", "Dark"),
        language: pick("语言", "Language"),
        language_zh: "中文".to_string(),
        language_en: "English".to_string(),
        fullscreen: pick("全屏", "Enter Full Screen"),
        devtools: pick("开发者工具", "Developer Tools"),
        gateway: pick("网关", "Gateway"),
        manage: pick("管理网关…", "Manage Gateways…"),
        restart: pick("重新连接", "Reconnect"),
        open_browser: pick("在浏览器中打开", "Open in Browser"),
        window: pick("窗口", "Window"),
        minimize: pick("最小化", "Minimize"),
        close_window: pick("关闭窗口", "Close Window"),
    }
}

#[cfg(test)]
pub fn gateway_menu_model(state: &ShellState) -> GatewayMenuModel {
    GatewayMenuModel {
        profiles: state
            .profiles
            .iter()
            .map(|profile| {
                (
                    format!("{PROFILE_PREFIX}{}", profile.id),
                    profile.label.clone(),
                    profile.id == state.active_profile_id,
                )
            })
            .collect(),
        manage_accelerator: "CmdOrCtrl+Shift+G".to_string(),
        open_browser_enabled: state.status.state == "online",
        checked_theme: state.theme.clone(),
        checked_locale: state.locale.clone(),
    }
}

pub fn build_menu(app: &AppHandle<Wry>, state: &ShellState) -> tauri::Result<Menu<Wry>> {
    let text = menu_text(&state.locale);
    let about = PredefinedMenuItem::about(app, Some(&text.about), None)?;
    let quit = PredefinedMenuItem::quit(app, Some(&text.quit))?;
    let app_menu = Submenu::with_items(
        app,
        "Volto Desktop",
        true,
        &[&about, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let undo = PredefinedMenuItem::undo(app, Some(&text.undo))?;
    let redo = PredefinedMenuItem::redo(app, Some(&text.redo))?;
    let cut = PredefinedMenuItem::cut(app, Some(&text.cut))?;
    let copy = PredefinedMenuItem::copy(app, Some(&text.copy))?;
    let paste = PredefinedMenuItem::paste(app, Some(&text.paste))?;
    let select_all = PredefinedMenuItem::select_all(app, Some(&text.select_all))?;
    let edit_menu = Submenu::with_items(
        app,
        &text.edit,
        true,
        &[
            &undo,
            &redo,
            &PredefinedMenuItem::separator(app)?,
            &cut,
            &copy,
            &paste,
            &select_all,
        ],
    )?;

    let reload = MenuItem::with_id(app, RELOAD_ID, &text.reload, true, Some("CmdOrCtrl+R"))?;

    let theme_items: Vec<CheckMenuItem<Wry>> = [
        (profiles::THEME_SYSTEM, text.theme_system.as_str()),
        (profiles::THEME_LIGHT, text.theme_light.as_str()),
        (profiles::THEME_DARK, text.theme_dark.as_str()),
    ]
    .into_iter()
    .map(|(value, label)| {
        CheckMenuItem::with_id(
            app,
            format!("{THEME_PREFIX}{value}"),
            label,
            true,
            state.theme == value,
            None::<&str>,
        )
    })
    .collect::<tauri::Result<Vec<_>>>()?;
    let theme_refs: Vec<&dyn IsMenuItem<Wry>> =
        theme_items.iter().map(|item| item as &dyn IsMenuItem<Wry>).collect();
    let theme_menu = Submenu::with_items(app, &text.theme, true, &theme_refs)?;

    let locale_items: Vec<CheckMenuItem<Wry>> = [
        (profiles::LOCALE_ZH, text.language_zh.as_str()),
        (profiles::LOCALE_EN, text.language_en.as_str()),
    ]
    .into_iter()
    .map(|(value, label)| {
        CheckMenuItem::with_id(
            app,
            format!("{LOCALE_PREFIX}{value}"),
            label,
            true,
            state.locale == value,
            None::<&str>,
        )
    })
    .collect::<tauri::Result<Vec<_>>>()?;
    let locale_refs: Vec<&dyn IsMenuItem<Wry>> =
        locale_items.iter().map(|item| item as &dyn IsMenuItem<Wry>).collect();
    let locale_menu = Submenu::with_items(app, &text.language, true, &locale_refs)?;

    let fullscreen = PredefinedMenuItem::fullscreen(app, Some(&text.fullscreen))?;
    let reload_separator = PredefinedMenuItem::separator(app)?;
    let preferences_separator = PredefinedMenuItem::separator(app)?;
    let view_separator = PredefinedMenuItem::separator(app)?;
    #[cfg(debug_assertions)]
    let devtools_separator = PredefinedMenuItem::separator(app)?;
    #[cfg(debug_assertions)]
    let devtools =
        MenuItem::with_id(app, DEVTOOLS_ID, &text.devtools, true, Some("Alt+CmdOrCtrl+I"))?;
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut view_items: Vec<&dyn IsMenuItem<Wry>> = vec![
        &reload,
        &reload_separator,
        &theme_menu,
        &locale_menu,
        &preferences_separator,
        &fullscreen,
        &view_separator,
    ];
    #[cfg(debug_assertions)]
    {
        view_items.push(&devtools_separator);
        view_items.push(&devtools);
    }
    let view_menu = Submenu::with_items(app, &text.view, true, &view_items)?;

    let mut gateway_items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for profile in &state.profiles {
        gateway_items.push(Box::new(CheckMenuItem::with_id(
            app,
            format!("{PROFILE_PREFIX}{}", profile.id),
            &profile.label,
            true,
            profile.id == state.active_profile_id,
            None::<&str>,
        )?));
    }
    gateway_items.push(Box::new(PredefinedMenuItem::separator(app)?));
    gateway_items.push(Box::new(MenuItem::with_id(
        app,
        MANAGE_ID,
        &text.manage,
        true,
        Some("CmdOrCtrl+Shift+G"),
    )?));
    gateway_items.push(Box::new(MenuItem::with_id(
        app,
        RESTART_ID,
        &text.restart,
        state.status.state == "online" || state.status.state == "offline",
        None::<&str>,
    )?));
    gateway_items.push(Box::new(MenuItem::with_id(
        app,
        OPEN_BROWSER_ID,
        &text.open_browser,
        state.status.state == "online",
        None::<&str>,
    )?));
    let gateway_refs: Vec<&dyn IsMenuItem<Wry>> =
        gateway_items.iter().map(|item| item.as_ref()).collect();
    let gateway_menu = Submenu::with_items(app, &text.gateway, true, &gateway_refs)?;

    let minimize = PredefinedMenuItem::minimize(app, Some(&text.minimize))?;
    let close = PredefinedMenuItem::close_window(app, Some(&text.close_window))?;
    let window_menu = Submenu::with_items(app, &text.window, true, &[&minimize, &close])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &edit_menu,
            &view_menu,
            &gateway_menu,
            &window_menu,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(theme: &str, locale: &str) -> ShellState {
        let mut persisted = profiles::default_persisted();
        persisted.theme = theme.to_string();
        persisted.locale = locale.to_string();
        persisted.profiles.push(profiles::Profile {
            id: "remote".into(),
            label: "Build box".into(),
            kind: profiles::Kind::Remote,
            url: "https://gw.example.com".into(),
            managed: false,
            token: Some("tok".into()),
        });
        persisted.active_profile_id = "remote".into();
        ShellState {
            profiles: profiles::to_public(&persisted.profiles),
            active_profile_id: persisted.active_profile_id,
            status: profiles::Status {
                state: "online".into(),
                profile_id: "remote".into(),
                url: Some("https://gw.example.com".into()),
                version: Some("0.2.1".into()),
                mode: Some("remote".into()),
                degraded: false,
                detail: None,
                error: None,
            },
            theme: persisted.theme,
            locale: persisted.locale,
            platform: "darwin".into(),
            app_version: "0.0.1".into(),
        }
    }

    #[test]
    fn lists_profiles_with_the_active_one_checked() {
        let model = gateway_menu_model(&state("dark", "en"));
        assert_eq!(model.profiles.len(), 2);
        assert_eq!(model.profiles[1].0, "profile:remote");
        assert!(model.profiles[1].2);
        assert!(!model.profiles[0].2);
        assert!(model.open_browser_enabled);
        assert_eq!(model.checked_theme, "dark");
        assert_eq!(model.checked_locale, "en");
    }

    #[test]
    fn disables_open_in_browser_while_offline() {
        let mut value = state("system", "zh");
        value.status.state = "offline".into();
        let model = gateway_menu_model(&value);
        assert!(!model.open_browser_enabled);
    }

    #[test]
    fn localizes_every_menu_group() {
        let zh = menu_text("zh");
        assert_eq!(zh.view, "视图");
        assert_eq!(zh.theme_dark, "深色");
        assert_eq!(zh.language_en, "English");
        assert_eq!(zh.manage, "管理网关…");

        let en = menu_text("en");
        assert_eq!(en.view, "View");
        assert_eq!(en.theme_dark, "Dark");
        assert_eq!(en.language_zh, "中文");
        assert_eq!(en.manage, "Manage Gateways…");
        assert_eq!(en.open_browser, "Open in Browser");
    }
}
