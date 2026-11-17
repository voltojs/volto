//! Owns the local gateway child process.
//!
//! The CLI's stdout is a contract (`apps/gateway/src/cli.ts`): exactly two
//! lines, the listening address and the authenticated URL. Readiness means
//! both have arrived; anything else (early exit, timeout) is a startup error
//! carrying the tail of stderr, because "it did not start" alone is not
//! actionable.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use url::Url;

use crate::profiles::Profile;
use crate::runtime::{EntryKind, GatewayEntry, NodeRuntime};

const STDERR_TAIL_LINES: usize = 40;
const ERROR_TAIL_LINES: usize = 8;
const DEGRADED_MARKERS: [&str; 2] = ["Sessions are now saved to", "sqlite session store"];

/// PID of the managed gateway, for the signal guard. A forced termination of
/// the desktop app does not run Rust destructors, so a process signal handler
/// is the only way to avoid orphaning the gateway on SIGTERM/SIGINT/SIGHUP.
#[cfg(unix)]
static ACTIVE_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

#[cfg(unix)]
fn set_active_pid(pid: Option<u32>) {
    ACTIVE_PID.store(pid.map(|value| value as i32).unwrap_or(0), std::sync::atomic::Ordering::SeqCst);
}

#[cfg(not(unix))]
fn set_active_pid(_pid: Option<u32>) {}

/// Install the termination guard once, before the app starts.
#[cfg(unix)]
pub fn install_signal_guard() {
    extern "C" fn handler(signal: i32) {
        let pid = ACTIVE_PID.load(std::sync::atomic::Ordering::SeqCst);
        if pid > 0 {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        unsafe {
            libc::_exit(128 + signal);
        }
    }
    unsafe {
        libc::signal(libc::SIGTERM, handler as libc::sighandler_t);
        libc::signal(libc::SIGINT, handler as libc::sighandler_t);
        libc::signal(libc::SIGHUP, handler as libc::sighandler_t);
    }
}

enum StreamLine {
    Stdout(String),
    Stderr(String),
}

#[derive(Debug)]
pub struct RunningGateway {
    pub url: String,
    pub token: String,
    pub degraded: bool,
    child: Option<Child>,
}

impl RunningGateway {
    pub fn stop(&mut self) {
        set_active_pid(None);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for RunningGateway {
    fn drop(&mut self) {
        self.stop();
    }
}

/// `volto gateway 0.2.1 listening on http://127.0.0.1:3100` -> the URL.
pub fn parse_listening(line: &str) -> Option<String> {
    let marker = "listening on ";
    let start = line.find(marker)? + marker.len();
    let rest = line[start..].trim();
    let url = rest.split_whitespace().next()?;
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url.to_string())
    } else {
        None
    }
}

/// `Open: http://…/?token=abc` -> `abc`; a line without a token -> `""`.
pub fn parse_open_token(line: &str) -> String {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("Open:") {
        return String::new();
    }
    let Some(raw_url) = trimmed["Open:".len()..].split_whitespace().next() else {
        return String::new();
    };
    Url::parse(raw_url)
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "token")
                .map(|(_, value)| value.to_string())
        })
        .unwrap_or_default()
}

/// Port the managed gateway binds. Empty URL means "let the OS pick".
pub fn gateway_port(profile: &Profile) -> u16 {
    if profile.url.is_empty() {
        return 0;
    }
    Url::parse(&profile.url)
        .ok()
        .and_then(|url| url.port())
        .unwrap_or(0)
}

fn tail(lines: &[String], count: usize) -> String {
    let start = lines.len().saturating_sub(count);
    lines[start..].join("\n")
}

pub fn start(
    node: &NodeRuntime,
    entry: &GatewayEntry,
    profile: &Profile,
    timeout: Duration,
) -> Result<RunningGateway, String> {
    let mut command = Command::new(&node.command);
    if entry.kind == EntryKind::Script {
        command.arg(&entry.path);
    }
    command
        .arg("--port")
        .arg(gateway_port(profile).to_string())
        .arg("--no-open")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动本地网关（{}）：{error}", node.command))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = channel::<StreamLine>();

    if let Some(stdout) = stdout {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(StreamLine::Stdout(line)).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(stderr) = stderr {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if tx.send(StreamLine::Stderr(line)).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let deadline = Instant::now() + timeout;
    let mut url: Option<String> = None;
    let mut token = String::new();
    let mut saw_open = false;
    let mut degraded = false;

    loop {
        if url.is_some() && saw_open {
            set_active_pid(child.id().into());
            return Ok(RunningGateway {
                url: url.unwrap_or_default(),
                token,
                degraded,
                child: Some(child),
            });
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "本地网关在 {} 秒内没有启动{}",
                timeout.as_secs(),
                tail(&stderr_tail.lock().unwrap(), ERROR_TAIL_LINES)
                    .is_empty()
                    .then(String::new)
                    .unwrap_or_else(|| {
                        format!(
                            "：\n{}",
                            tail(&stderr_tail.lock().unwrap(), ERROR_TAIL_LINES)
                        )
                    })
            ));
        }

        match rx.recv_timeout(remaining.min(Duration::from_millis(200))) {
            Ok(StreamLine::Stdout(line)) => {
                if url.is_none() {
                    url = parse_listening(&line);
                }
                if line.trim_start().starts_with("Open:") {
                    token = parse_open_token(&line);
                    saw_open = true;
                }
            }
            Ok(StreamLine::Stderr(line)) => {
                if DEGRADED_MARKERS.iter().any(|marker| line.contains(marker)) {
                    degraded = true;
                }
                let mut tail_lines = stderr_tail.lock().unwrap();
                tail_lines.push(line);
                if tail_lines.len() > STDERR_TAIL_LINES {
                    tail_lines.remove(0);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Ok(Some(status)) = child.try_wait() {
                    let detail = tail(&stderr_tail.lock().unwrap(), ERROR_TAIL_LINES);
                    return Err(format!(
                        "本地网关启动失败（{}）{}",
                        status,
                        if detail.is_empty() {
                            String::new()
                        } else {
                            format!("：\n{detail}")
                        }
                    ));
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                if let Ok(Some(status)) = child.try_wait() {
                    let detail = tail(&stderr_tail.lock().unwrap(), ERROR_TAIL_LINES);
                    return Err(format!(
                        "本地网关启动失败（{}）{}",
                        status,
                        if detail.is_empty() {
                            String::new()
                        } else {
                            format!("：\n{detail}")
                        }
                    ));
                }
            }
        }
    }
}


impl crate::controller::GatewayHandle for RunningGateway {
    fn stop(&mut self) {
        RunningGateway::stop(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{EntryKind, GatewayEntry, NodeRuntime};

    fn has_node() -> bool {
        Command::new("node")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn temp_script(tag: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "volto-supervisor-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fake-gateway.mjs");
        std::fs::write(&path, body).unwrap();
        path
    }

    fn node_runtime() -> NodeRuntime {
        NodeRuntime {
            command: "node".into(),
            label: "node test".into(),
        }
    }

    fn profile() -> Profile {
        Profile {
            id: "local".into(),
            label: "Local".into(),
            kind: crate::profiles::Kind::Local,
            url: String::new(),
            managed: true,
            token: None,
        }
    }

    #[test]
    fn parses_the_cli_contract() {
        assert_eq!(
            parse_listening("volto gateway 0.2.1 listening on http://127.0.0.1:3100"),
            Some("http://127.0.0.1:3100".into())
        );
        assert_eq!(parse_listening("remote mode"), None);
        assert_eq!(
            parse_open_token("Open: http://127.0.0.1:3100/?token=abc"),
            "abc"
        );
        assert_eq!(parse_open_token("Open: http://127.0.0.1:3100/"), "");
    }

    #[test]
    fn derives_the_requested_port() {
        assert_eq!(gateway_port(&profile()), 0);
        let mut with_url = profile();
        with_url.url = "http://127.0.0.1:3100".into();
        assert_eq!(gateway_port(&with_url), 3100);
    }

    #[test]
    fn resolves_once_both_lines_are_printed() {
        if !has_node() {
            return;
        }
        let script = temp_script(
            "ready",
            r#"
            console.log("volto gateway 9.9.9 listening on http://127.0.0.1:41234");
            console.log("Open: http://127.0.0.1:41234/?token=token-123");
            setInterval(() => {}, 1000);
            "#,
        );
        let entry = GatewayEntry {
            path: script.clone(),
            kind: EntryKind::Script,
        };
        let mut running = start(&node_runtime(), &entry, &profile(), Duration::from_secs(10)).unwrap();
        assert_eq!(running.url, "http://127.0.0.1:41234");
        assert_eq!(running.token, "token-123");
        assert!(!running.degraded);
        running.stop();
        std::fs::remove_dir_all(script.parent().unwrap()).ok();
    }

    #[test]
    fn marks_a_fallback_session_store_as_degraded() {
        if !has_node() {
            return;
        }
        let script = temp_script(
            "degraded",
            r#"
            console.error("Sessions are now saved to /tmp/sessions-store");
            setTimeout(() => {
              console.log("volto gateway 9.9.9 listening on http://127.0.0.1:41235");
              console.log("Open: http://127.0.0.1:41235/?token=t");
            }, 30);
            setInterval(() => {}, 1000);
            "#,
        );
        let entry = GatewayEntry {
            path: script.clone(),
            kind: EntryKind::Script,
        };
        let mut running = start(&node_runtime(), &entry, &profile(), Duration::from_secs(10)).unwrap();
        assert!(running.degraded);
        running.stop();
        std::fs::remove_dir_all(script.parent().unwrap()).ok();
    }

    #[test]
    fn reports_an_early_exit_with_stderr() {
        if !has_node() {
            return;
        }
        let script = temp_script(
            "exit",
            r#"
            console.error("fatal: cannot load gateway");
            process.exit(1);
            "#,
        );
        let entry = GatewayEntry {
            path: script.clone(),
            kind: EntryKind::Script,
        };
        let error = start(&node_runtime(), &entry, &profile(), Duration::from_secs(10)).unwrap_err();
        assert!(error.contains("fatal: cannot load gateway"), "{error}");
        std::fs::remove_dir_all(script.parent().unwrap()).ok();
    }

    #[test]
    fn times_out_on_a_silent_process() {
        if !has_node() {
            return;
        }
        let script = temp_script("silent", "setInterval(() => {}, 1000);");
        let entry = GatewayEntry {
            path: script.clone(),
            kind: EntryKind::Script,
        };
        let error = start(
            &node_runtime(),
            &entry,
            &profile(),
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(error.contains("没有启动"), "{error}");
        std::fs::remove_dir_all(script.parent().unwrap()).ok();
    }
}
