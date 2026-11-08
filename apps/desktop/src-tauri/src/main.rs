//! AI Repeat — Tauri v2 desktop shell.
//!
//! Responsibilities (kept intentionally tiny):
//!   1. Own the WebView2 window rendering the Arabic RTL UI.
//!   2. Deliver the agent's per-session token to the UI via IPC — the token
//!      never travels through the network or the DOM globals.
//!   3. In dev builds, launch the local agent service (npm run agent) if it
//!      isn't already listening. Production packaging ships the agent as a
//!      sidecar binary (next milestone; see docs/IMPLEMENTATION_STATUS.md).
//!
//! All automation logic lives in services/agent — this shell has no
//! automation privileges by design.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

const AGENT_PORT: u16 = 8757;

/// Data dir mirroring services/agent/src/config.ts resolution.
fn data_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        // Dev: repo-local .local-dev (src-tauri → apps/desktop → apps → repo root)
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest.join("..").join("..").join("..").join(".local-dev")
    } else {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
        PathBuf::from(appdata).join("AIRepeat")
    }
}

fn agent_url() -> String {
    format!("http://127.0.0.1:{}", AGENT_PORT)
}

fn agent_listening() -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", AGENT_PORT).parse().expect("valid addr"),
        Duration::from_millis(400),
    )
    .is_ok()
}

/// IPC command: hand the UI the loopback session token (header-only auth).
#[tauri::command]
fn get_session_token() -> Result<String, String> {
    let path = data_dir().join("session-token");
    std::fs::read_to_string(&path)
        .map(|t| t.trim().to_string())
        .map_err(|_| format!("AGENT_TOKEN_UNAVAILABLE: مفيش توكن جلسة في {:?}", path))
}

/// IPC command: agent reachability for the sidebar status dot.
#[tauri::command]
fn agent_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "listening": agent_listening(),
        "url": agent_url(),
    }))
}

/// Dev convenience: start the agent if it isn't running. In release builds the
/// agent runs as the bundled Node-SEA sidecar binary (see scripts/build-sidecar.mjs).
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_session_token, agent_status])
        .setup(|app| {
            let _ = &app; // used only by the release sidecar branch
            if agent_listening() {
                println!("[shell] agent already listening on {}", agent_url());
                return Ok(());
            }
            #[cfg(debug_assertions)]
            {
                let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..").join("..").join("..");
                spawn_dev_agent(&repo);
            }
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_shell::ShellExt;
                let sidecar = app
                    .shell()
                    .sidecar("ai-repeat-agent")
                    .expect("agent sidecar binary missing from bundle");
                let (_rx, _child) = sidecar
                    .env("AI_REPEAT_DEV_MODE", "false")
                    .spawn()
                    .expect("failed to spawn agent sidecar");
                println!("[shell] spawned agent sidecar");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AI Repeat shell");
}

#[cfg(windows)]
fn spawn_dev_agent(repo: &std::path::Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let res = Command::new("cmd")
        .args(["/C", "npm run agent"])
        .current_dir(repo)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    match res {
        Ok(_) => println!("[shell] spawned dev agent (npm run agent)"),
        Err(e) => eprintln!("[shell] failed to spawn agent: {e}"),
    }
}

#[cfg(not(windows))]
fn spawn_dev_agent(repo: &std::path::Path) {
    let res = Command::new("npm")
        .args(["run", "agent"])
        .current_dir(repo)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match res {
        Ok(_) => println!("[shell] spawned dev agent (npm run agent)"),
        Err(e) => eprintln!("[shell] failed to spawn agent: {e}"),
    }
}
