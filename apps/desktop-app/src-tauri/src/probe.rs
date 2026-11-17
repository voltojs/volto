//! Decide whether a gateway is usable before the content webview is pointed
//! at it.
//!
//! HTTP goes through the system `curl`: the offline crate cache has no HTTP
//! client, and curl is present on every supported platform. The access token
//! is passed in a private (0600) curl config file rather than argv, where
//! `ps` would expose it.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Probe {
    Online {
        version: Option<String>,
        mode: Option<String>,
    },
    Offline {
        error: String,
    },
}

fn curl_bin() -> String {
    std::env::var("VOLTO_CURL").unwrap_or_else(|_| "curl".to_string())
}

fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

fn error_line(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
        .unwrap_or("未知错误")
        .to_string()
}

fn curl_status(url: &str) -> Result<String, String> {
    let output = Command::new(curl_bin())
        .args(["-sS", "-m", "4", "-o", null_device(), "-w", "%{http_code}"])
        .arg(url)
        .output()
        .map_err(|error| format!("无法执行 curl：{error}"))?;
    if !output.status.success() {
        return Err(error_line(&output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Parallel probes need distinct files even when two calls land in the same
/// clock tick; a timestamp alone collided and one test read another's body.
fn unique_path(suffix: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = NEXT.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "volto-probe-{}-{nanos}-{sequence}{suffix}",
        std::process::id()
    ))
}

struct TempFiles(Vec<PathBuf>);

impl Drop for TempFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(unix)]
fn write_private(path: &PathBuf, content: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes()).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn write_private(path: &PathBuf, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|error| error.to_string())
}

fn fetch_info(base: &str, token: Option<&str>, files: &TempFiles) -> Result<(String, String), String> {
    let body_path = files.0[0].clone();
    let mut command = Command::new(curl_bin());
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        let config_path = files.0[1].clone();
        let content = format!(
            "header = \"Authorization: Bearer {}\"\n",
            token.replace('"', "")
        );
        write_private(&config_path, &content)?;
        command.arg("--config").arg(&config_path);
    }
    let output = command
        .args(["-sS", "-m", "4", "-o"])
        .arg(&body_path)
        .args(["-w", "%{http_code}"])
        .arg(format!("{base}/gateway-info"))
        .output()
        .map_err(|error| format!("无法执行 curl：{error}"))?;
    if !output.status.success() {
        return Err(error_line(&output.stderr));
    }
    let status = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let body = fs::read_to_string(&body_path).unwrap_or_default();
    Ok((status, body))
}

pub fn probe(url: &str, token: Option<&str>) -> Probe {
    let base = url.trim_end_matches('/');

    match curl_status(&format!("{base}/health")) {
        Err(error) => {
            return Probe::Offline {
                error: format!("无法连接网关：{error}"),
            }
        }
        Ok(status) if status != "200" => {
            return Probe::Offline {
                error: format!("无法连接网关：HTTP {status}"),
            }
        }
        Ok(_) => {}
    }

    if let Ok(status) = curl_status(&format!("{base}/")) {
        if status == "503" {
            return Probe::Offline {
                error: "网关没有可用的 Web UI（缺少 web 构建）".to_string(),
            };
        }
    }

    let files = TempFiles(vec![unique_path(".json"), unique_path(".curlrc")]);
    let (status, body) = match fetch_info(base, token, &files) {
        Ok(result) => result,
        Err(error) => {
            return Probe::Offline {
                error: format!("无法连接网关：{error}"),
            }
        }
    };
    if status == "401" || status == "403" {
        return Probe::Offline {
            error: if token.is_some_and(|value| !value.is_empty()) {
                "访问令牌无效或已过期".to_string()
            } else {
                "需要访问令牌：在网关机器上运行 volto token 获取".to_string()
            },
        };
    }
    if status != "200" {
        return Probe::Online {
            version: None,
            mode: None,
        };
    }
    let parsed: Option<Value> = serde_json::from_str(&body).ok();
    let version = parsed
        .as_ref()
        .and_then(|value| value.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mode = parsed
        .as_ref()
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        .filter(|value| *value == "local" || *value == "remote")
        .map(str::to_string);
    Probe::Online { version, mode }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    struct Server {
        url: String,
    }

    fn serve(responses: Vec<&'static str>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        Server {
            url: format!("http://127.0.0.1:{port}"),
        }
    }

    fn response(status: &str, body: &str) -> &'static str {
        let value = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        Box::leak(value.into_boxed_str())
    }

    #[test]
    fn reports_version_and_mode_for_an_authenticated_gateway() {
        let server = serve(vec![
            response("200 OK", "{\"status\":\"ok\"}"),
            response("200 OK", "<html></html>"),
            response("200 OK", "{\"version\":\"0.2.1\",\"mode\":\"remote\"}"),
        ]);
        assert_eq!(
            probe(&server.url, Some("secret")),
            Probe::Online {
                version: Some("0.2.1".into()),
                mode: Some("remote".into()),
            }
        );
    }

    #[test]
    fn asks_for_a_token_when_the_gateway_rejects_the_anonymous_probe() {
        let server = serve(vec![
            response("200 OK", "{}"),
            response("200 OK", "<html></html>"),
            response("401 Unauthorized", "{\"error\":\"Unauthorized\"}"),
        ]);
        assert_eq!(
            probe(&server.url, None),
            Probe::Offline {
                error: "需要访问令牌：在网关机器上运行 volto token 获取".into(),
            }
        );
    }

    #[test]
    fn reports_a_missing_web_build() {
        let server = serve(vec![
            response("200 OK", "{}"),
            response("503 Service Unavailable", "{\"error\":\"Web app not found\"}"),
        ]);
        assert_eq!(
            probe(&server.url, None),
            Probe::Offline {
                error: "网关没有可用的 Web UI（缺少 web 构建）".into(),
            }
        );
    }

    #[test]
    fn reports_a_non_200_health() {
        let server = serve(vec![response("500 Internal Server Error", "{}")]);
        assert_eq!(
            probe(&server.url, None),
            Probe::Offline {
                error: "无法连接网关：HTTP 500".into(),
            }
        );
    }

    #[test]
    fn reports_an_unreachable_gateway() {
        let Probe::Offline { error } = probe("http://127.0.0.1:1", None) else {
            panic!("expected offline");
        };
        assert!(error.contains("无法连接网关"), "{error}");
    }
}