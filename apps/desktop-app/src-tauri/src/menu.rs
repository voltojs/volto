//! Native application menu. The Gateway submenu mirrors the profile list, so
//! the app stays switchable when the management page is closed, and it is the
//! discoverable path to that page (Cmd/Ctrl+Shift+G).
//!
//! The model is a plain data structure so the shape (labels, ids, checked
//! radio, enabled state) is testable without Tauri.

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

use crate::profiles::ShellState;

pub const MANAGE_ID: &str = "manage";
pub const RESTART_ID: &str = "restart";
pub const OPEN_BROWSER_ID: &str = "open-browser";
pub const RELOAD_ID: &str = "reload";
#[cfg(debug_assertions)]
pub const DEVTOOLS_ID: &str = "devtools";
pub const PROFILE_PREFIX: &str = "profile:";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayMenuModel {
    pub profiles: Vec<(String, String, bool)>,
    pub manage_accelerator: String,
    pub open_browser_enabled: bool,
}

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
    }
}

pub fn build_menu(app: &AppHandle<Wry>, state: &ShellState) -> tauri::Result<Menu<Wry>> {
    let about = PredefinedMenuItem::about(app, Some("关于 Volto Desktop"), None)?;
    let quit = PredefinedMenuItem::quit(app, Some("退出 Volto Desktop"))?;
    let app_menu = Submenu::with_items(
        app,
        "Volto Desktop",
        true,
        &[&about, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let undo = PredefinedMenuItem::undo(app, Some("撤销"))?;
    let redo = PredefinedMenuItem::redo(app, Some("重做"))?;
    let cut = PredefinedMenuItem::cut(app, Some("剪切"))?;
    let copy = PredefinedMenuItem::copy(app, Some("复制"))?;
    let paste = PredefinedMenuItem::paste(app, Some("粘贴"))?;
    let select_all = PredefinedMenuItem::select_all(app, Some("全选"))?;
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
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

    let reload = MenuItem::with_id(app, RELOAD_ID, "重新加载界面", true, Some("CmdOrCtrl+R"))?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, Some("全屏"))?;
    let view_separator = PredefinedMenuItem::separator(app)?;
    #[cfg(debug_assertions)]
    let devtools_separator = PredefinedMenuItem::separator(app)?;
    #[cfg(debug_assertions)]
    let devtools = MenuItem::with_id(app, DEVTOOLS_ID, "开发者工具", true, Some("Alt+CmdOrCtrl+I"))?;
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut view_items: Vec<&dyn IsMenuItem<Wry>> = vec![&reload, &view_separator, &fullscreen];
    #[cfg(debug_assertions)]
    {
        view_items.push(&devtools_separator);
        view_items.push(&devtools);
    }
    let view_menu = Submenu::with_items(app, "视图", true, &view_items)?;

    let minimize = PredefinedMenuItem::minimize(app, Some("最小化"))?;
    let close = PredefinedMenuItem::close_window(app, Some("关闭窗口"))?;
    let window_menu = Submenu::with_items(app, "窗口", true, &[&minimize, &close])?;

    let model = gateway_menu_model(state);
    let profile_items: Vec<CheckMenuItem<Wry>> = model
        .profiles
        .iter()
        .map(|(id, label, checked)| {
            CheckMenuItem::with_id(app, id.clone(), label.clone(), true, *checked, None::<&str>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let manage = MenuItem::with_id(
        app,
        MANAGE_ID,
        "管理网关…",
        true,
        Some(model.manage_accelerator.as_str()),
    )?;
    let restart = MenuItem::with_id(app, RESTART_ID, "重新连接", true, None::<&str>)?;
    let open_browser = MenuItem::with_id(
        app,
        OPEN_BROWSER_ID,
        "在浏览器中打开",
        model.open_browser_enabled,
        None::<&str>,
    )?;
    let gateway_separator = PredefinedMenuItem::separator(app)?;
    let mut gateway_items: Vec<&dyn IsMenuItem<Wry>> = Vec::new();
    for item in &profile_items {
        gateway_items.push(item);
    }
    gateway_items.push(&gateway_separator);
    gateway_items.push(&manage);
    gateway_items.push(&restart);
    gateway_items.push(&open_browser);
    let gateway_menu = Submenu::with_items(app, "网关", true, &gateway_items)?;

    Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &view_menu, &gateway_menu, &window_menu],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{default_persisted, to_public, Kind, Profile, Status};

    fn state() -> ShellState {
        let mut persisted = default_persisted();
        persisted.profiles.push(Profile {
            id: "remote".into(),
            label: "Remote".into(),
            kind: Kind::Remote,
            url: "https://gw.example.com".into(),
            managed: false,
            token: None,
        });
        persisted.active_profile_id = "remote".into();
        let mut status = Status::idle("remote");
        status.state = "online".into();
        ShellState {
            profiles: to_public(&persisted.profiles),
            active_profile_id: persisted.active_profile_id,
            status,
            platform: "macos".into(),
            app_version: "0.0.1".into(),
        }
    }

    #[test]
    fn lists_profiles_with_the_active_one_checked() {
        let model = gateway_menu_model(&state());
        assert_eq!(model.profiles.len(), 2);
        assert_eq!(model.profiles[0].1, "本机网关");
        assert!(!model.profiles[0].2);
        assert_eq!(model.profiles[1].0, "profile:remote");
        assert!(model.profiles[1].2);
        assert_eq!(model.manage_accelerator, "CmdOrCtrl+Shift+G");
        assert!(model.open_browser_enabled);
    }

    #[test]
    fn disables_open_in_browser_while_offline() {
        let mut offline = state();
        offline.status.state = "offline".into();
        assert!(!gateway_menu_model(&offline).open_browser_enabled);
    }
}