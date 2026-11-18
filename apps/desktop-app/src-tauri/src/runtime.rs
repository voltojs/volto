//! Resolve how to start a local gateway: a Node runtime (>= 22) and the
//! gateway entry point.
//!
//! A GUI app started from Finder gets a minimal PATH, so a Node installed by
//! fnm/homebrew is usually not on it. The login shell is therefore the last
//! discovery step, and a failure names both remedies (install Node or point
//! `VOLTO_NODE` at one).

use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const MIN_NODE_MAJOR: u32 = 22;
const MAX_ANCESTOR_DEPTH: usize = 6;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeRuntime {
    pub command: String,
    pub label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Script,
    Binary,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayEntry {
    pub path: PathBuf,
    pub kind: EntryKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedRuntime {
    pub node: NodeRuntime,
    pub entry: GatewayEntry,
}

/// `v24.9.0` / `24.9.0` -> 24; anything unparseable -> None.
pub fn parse_node_major(output: &str) -> Option<u32> {
    let trimmed = output.trim();
    let without_v = trimmed.strip_prefix('v').unwrap_or(trimmed);
    let major = without_v.split('.').next()?;
    major.parse::<u32>().ok()
}

pub fn path_entries(path_env: Option<&str>) -> Vec<PathBuf> {
    let Some(path) = path_env else {
        return Vec::new();
    };
    env::split_paths(path)
        .filter(|entry| !entry.as_os_str().is_empty())
        .collect()
}

fn is_script(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("js") | Some("mjs") | Some("cjs")
    )
}

fn entry(path: PathBuf) -> GatewayEntry {
    let kind = if is_script(&path) {
        EntryKind::Script
    } else {
        EntryKind::Binary
    };
    GatewayEntry { path, kind }
}

/// Every place a gateway entry point could be, in priority order. Existence is
/// checked by the caller so the list itself stays pure.
pub fn entry_candidates(
    env_override: Option<&str>,
    resource_dir: Option<&Path>,
    cwd: &Path,
    exe_dir: &Path,
) -> Vec<GatewayEntry> {
    let mut candidates: Vec<GatewayEntry> = Vec::new();
    let mut push = |candidate: GatewayEntry| {
        if !candidates.iter().any(|known| known.path == candidate.path) {
            candidates.push(candidate);
        }
    };

    if let Some(value) = env_override.map(str::trim).filter(|value| !value.is_empty()) {
        push(entry(PathBuf::from(value)));
    }
    if let Some(resources) = resource_dir {
        push(entry(resources.join("gateway").join("bin.js")));
    }
    push(entry(cwd.join("..").join("gateway").join("dist").join("bin.js")));

    let mut current = Some(exe_dir);
    for _ in 0..MAX_ANCESTOR_DEPTH {
        let Some(dir) = current else { break };
        push(entry(
            dir.join("apps")
                .join("gateway")
                .join("dist")
                .join("bin.js"),
        ));
        current = dir.parent();
    }
    candidates
}

fn executable(name: &str, dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join(format!("{name}.exe"))
    } else {
        dir.join(name)
    }
}

fn file_exists(path: &Path) -> bool {
    path.is_file()
}

fn node_version(command: &str) -> Option<String> {
    let output = Command::new(command).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Choose a Node runtime from an explicit override or PATH-like candidates.
/// `version_of` is injected so the rule is testable without spawning.
pub fn select_node(
    override_path: Option<&str>,
    candidates: &[String],
    version_of: &dyn Fn(&str) -> Option<String>,
) -> Result<NodeRuntime, String> {
    if let Some(value) = override_path.map(str::trim).filter(|value| !value.is_empty()) {
        let Some(version) = version_of(value) else {
            return Err(format!("VOLTO_NODE 无法执行：{value}"));
        };
        let Some(major) = parse_node_major(&version) else {
            return Err(format!("VOLTO_NODE 版本无法识别：{version}"));
        };
        if major < MIN_NODE_MAJOR {
            return Err(format!(
                "VOLTO_NODE 需要 Node ≥ {MIN_NODE_MAJOR}，当前 {version}"
            ));
        }
        return Ok(NodeRuntime {
            command: value.to_string(),
            label: format!("node {}", version.trim_start_matches('v')),
        });
    }

    let mut older: Option<String> = None;
    let mut seen: HashSet<String> = HashSet::new();
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        let Some(version) = version_of(candidate) else {
            continue;
        };
        match parse_node_major(&version) {
            Some(major) if major >= MIN_NODE_MAJOR => {
                return Ok(NodeRuntime {
                    command: candidate.clone(),
                    label: format!("node {}", version.trim_start_matches('v')),
                });
            }
            Some(_) => older = Some(version),
            None => continue,
        }
    }

    let detail = older
        .map(|version| format!("PATH 上的 Node {version} 低于 {MIN_NODE_MAJOR}"))
        .unwrap_or_else(|| "未找到 Node".to_string());
    Err(format!(
        "{detail}：请安装 Node ≥ {MIN_NODE_MAJOR}，或设置 VOLTO_NODE。"
    ))
}

fn login_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            "cmd".to_string()
        } else {
            "/bin/zsh".to_string()
        }
    })
}

fn login_shell_lookup(command: &str) -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    for shell in [login_shell(), "/bin/zsh".into(), "/bin/bash".into(), "/bin/sh".into()] {
        let output = Command::new(&shell)
            .arg("-lc")
            .arg(format!("command -v {command}"))
            .output()
            .ok()?;
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn resolve_entry(
    env_override: Option<&str>,
    resource_dir: Option<&Path>,
    cwd: &Path,
    exe_dir: &Path,
) -> Result<GatewayEntry, String> {
    let candidates = entry_candidates(env_override, resource_dir, cwd, exe_dir);
    if let Some(value) = env_override.map(str::trim).filter(|value| !value.is_empty()) {
        let first = candidates
            .first()
            .cloned()
            .unwrap_or_else(|| entry(PathBuf::from(value)));
        if !file_exists(&first.path) {
            return Err(format!("VOLTO_GATEWAY_BIN 指向的文件不存在：{value}"));
        }
        return Ok(first);
    }
    for candidate in candidates {
        if file_exists(&candidate.path) {
            return Ok(candidate);
        }
    }
    if let Some(path) = login_shell_lookup("volto") {
        return Ok(entry(PathBuf::from(path)));
    }
    let dev_hint = if cfg!(debug_assertions) {
        format!(
            "（开发环境入口：{}，可用 VOLTO_GATEWAY_BIN 指定）",
            cwd.join("../gateway/dist/bin.js").display()
        )
    } else {
        String::new()
    };
    Err(format!(
        "本机没有可用的 Volto 网关。请按安装指南安装 Node 22+ 与 Volto，或添加远程网关。{dev_hint}"
    ))
}

/// Production entry point: the environment plus the paths a running app knows.
pub fn resolve_runtime(resource_dir: Option<&Path>) -> Result<ResolvedRuntime, String> {
    let cwd = env::current_dir().map_err(|error| format!("无法读取工作目录：{error}"))?;
    let exe = env::current_exe().map_err(|error| format!("无法读取可执行文件路径：{error}"))?;
    let exe_dir = exe.parent().unwrap_or(Path::new("."));
    let entry = resolve_entry(
        env::var("VOLTO_GATEWAY_BIN").ok().as_deref(),
        resource_dir,
        &cwd,
        exe_dir,
    )?;

    let mut candidates: Vec<String> = Vec::new();
    for dir in path_entries(env::var("PATH").ok().as_deref()) {
        let candidate = executable("node", &dir);
        if file_exists(&candidate) {
            candidates.push(candidate.to_string_lossy().to_string());
        }
    }
    if let Some(path) = login_shell_lookup("node") {
        candidates.push(path);
    }
    let node = select_node(
        env::var("VOLTO_NODE").ok().as_deref(),
        &candidates,
        &node_version,
    )?;
    Ok(ResolvedRuntime { node, entry })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "volto-runtime-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_node_major_versions() {
        assert_eq!(parse_node_major("v24.9.0\n"), Some(24));
        assert_eq!(parse_node_major("22.1.0"), Some(22));
        assert_eq!(parse_node_major("node: command not found"), None);
    }

    #[test]
    fn puts_the_env_override_first() {
        let candidates = entry_candidates(
            Some("/opt/volto/bin.js"),
            Some(Path::new("/res")),
            Path::new("/repo/apps/desktop-app"),
            Path::new("/repo/apps/desktop-app/src-tauri/target/debug"),
        );
        assert_eq!(candidates[0].path, PathBuf::from("/opt/volto/bin.js"));
        assert_eq!(candidates[0].kind, EntryKind::Script);
        assert_eq!(candidates[1].path, PathBuf::from("/res/gateway/bin.js"));
        assert!(candidates
            .iter()
            .any(|candidate| candidate.path.ends_with("apps/gateway/dist/bin.js")));
    }

    #[test]
    fn treats_a_non_script_override_as_a_binary() {
        let candidates = entry_candidates(
            Some("/usr/local/bin/volto"),
            None,
            Path::new("/repo/apps/desktop-app"),
            Path::new("/repo/apps/desktop-app/src-tauri/target/debug"),
        );
        assert_eq!(candidates[0].kind, EntryKind::Binary);
    }

    #[test]
    fn selects_the_first_supported_node() {
        let runtime = select_node(
            None,
            &["/old/node".into(), "/new/node".into()],
            &|path| match path {
                "/old/node" => Some("v18.20.0".into()),
                "/new/node" => Some("v24.9.0".into()),
                _ => None,
            },
        )
        .unwrap();
        assert_eq!(runtime.command, "/new/node");
        assert_eq!(runtime.label, "node 24.9.0");
    }

    #[test]
    fn refuses_an_unsupported_override() {
        let error = select_node(Some("/old/node"), &[], &|_| Some("v18.0.0".into())).unwrap_err();
        assert!(error.contains("VOLTO_NODE 需要 Node ≥ 22"));
    }

    #[test]
    fn explains_how_to_install_node() {
        let error = select_node(None, &["/old/node".into()], &|_| Some("v20.0.0".into())).unwrap_err();
        assert!(error.contains("请安装 Node ≥ 22"));
    }

    #[test]
    fn resolves_an_existing_entry_from_the_search_list() {
        let dir = temp_dir("entry");
        let gateway = dir.join("apps").join("gateway").join("dist");
        std::fs::create_dir_all(&gateway).unwrap();
        std::fs::write(gateway.join("bin.js"), "// fake").unwrap();
        let cwd = dir.join("apps").join("desktop-app");
        std::fs::create_dir_all(&cwd).unwrap();
        let entry = resolve_entry(None, None, &cwd, &cwd.join("src-tauri/target/debug")).unwrap();
        assert!(entry.path.ends_with("gateway/dist/bin.js"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reports_a_missing_env_override() {
        let dir = temp_dir("override");
        let cwd = dir.join("apps").join("desktop-app");
        std::fs::create_dir_all(&cwd).unwrap();
        let error = resolve_entry(
            Some("/nope/bin.js"),
            None,
            &cwd,
            &cwd.join("src-tauri/target/debug"),
        )
        .unwrap_err();
        assert!(error.contains("/nope/bin.js"));
        std::fs::remove_dir_all(dir).ok();
    }
}