use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
use std::path::Path;
#[cfg(not(windows))]
use std::process::{Command, Stdio};
#[cfg(not(windows))]
use std::time::Duration;

#[cfg(not(windows))]
const LOGIN_SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(not(windows))]
const PATH_MARKER: char = '\x1e';

static RESOLVED_COMMANDS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

#[cfg(not(windows))]
static RESOLVED_SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();

#[cfg(not(windows))]
pub(crate) async fn child_path_env() -> Option<String> {
    let shell_path = tokio::task::spawn_blocking(|| {
        RESOLVED_SHELL_PATH
            .get_or_init(|| login_shell_path(LOGIN_SHELL_PATH_TIMEOUT))
            .clone()
    })
    .await
    .ok()
    .flatten()?;
    Some(merge_child_path_env(
        &shell_path,
        std::env::var("PATH").ok().as_deref(),
    ))
}

#[cfg(windows)]
pub(crate) async fn child_path_env() -> Option<String> {
    None
}

#[cfg(not(windows))]
fn merge_child_path_env(shell_path: &str, inherited_path: Option<&str>) -> String {
    match inherited_path {
        Some(current) if !current.is_empty() => format!("{shell_path}:{current}"),
        _ => shell_path.to_string(),
    }
}

pub(crate) async fn find_cli_command(
    command: &str,
    windows_candidates: &[&str],
) -> Result<PathBuf, String> {
    if let Some(path) = cached_command(command) {
        return Ok(path);
    }

    let command = command.to_string();
    let cache_key = command.clone();
    let windows_candidates = windows_candidates
        .iter()
        .map(|candidate| (*candidate).to_string())
        .collect::<Vec<_>>();
    let path = tokio::task::spawn_blocking(move || {
        find_cli_command_uncached(&command, &windows_candidates)
    })
    .await
    .map_err(|e| format!("Failed to resolve CLI command: {e}"))??;

    cache_command(cache_key, path.clone());
    Ok(path)
}

fn command_cache() -> &'static Mutex<HashMap<String, PathBuf>> {
    RESOLVED_COMMANDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_command(command: &str) -> Option<PathBuf> {
    let mut cache = command_cache().lock().ok()?;
    let path = cache.get(command)?.clone();
    if path.exists() {
        Some(path)
    } else {
        cache.remove(command);
        None
    }
}

fn cache_command(command: String, path: PathBuf) {
    if let Ok(mut cache) = command_cache().lock() {
        cache.insert(command, path);
    }
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn find_cli_command_uncached(
    command: &str,
    windows_candidates: &[String],
) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        for candidate in windows_candidates
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(command))
        {
            if let Ok(path) = which::which(candidate) {
                return Ok(path);
            }
        }
        if let Some(path) = find_windows_cli_command(command, windows_candidates) {
            return Ok(path);
        }
        return Err(format!("`{command}` not found on PATH"));
    }

    #[cfg(not(windows))]
    {
        if let Ok(path) = which::which(command) {
            return Ok(path);
        }

        if let Some(full_path) = login_shell_path(LOGIN_SHELL_PATH_TIMEOUT) {
            if let Ok(path) = which::which_in(command, Some(&full_path), ".") {
                return Ok(path);
            }
        }

        Err(format!("`{command}` not found on PATH"))
    }
}

#[cfg(windows)]
fn find_windows_cli_command(command: &str, windows_candidates: &[String]) -> Option<PathBuf> {
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
    let user_profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    find_windows_cli_command_with_env(
        command,
        windows_candidates,
        app_data.as_deref(),
        user_profile.as_deref(),
    )
}

#[cfg(windows)]
fn find_windows_cli_command_with_env(
    command: &str,
    windows_candidates: &[String],
    app_data: Option<&Path>,
    user_profile: Option<&Path>,
) -> Option<PathBuf> {
    let npm_dir = windows_user_npm_bin_dir(app_data, user_profile)?;
    let mut candidates = windows_candidates.to_vec();
    let ps1_candidate = format!("{command}.ps1");
    if !candidates
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(&ps1_candidate))
    {
        candidates.push(ps1_candidate);
    }

    for candidate in candidates {
        let path = npm_dir.join(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

#[cfg(windows)]
fn windows_user_npm_bin_dir(app_data: Option<&Path>, user_profile: Option<&Path>) -> Option<PathBuf> {
    app_data
        .map(|path| path.join("npm"))
        .or_else(|| {
            user_profile.map(|path| path.join("AppData").join("Roaming").join("npm"))
        })
        .filter(|path| path.is_dir())
}

#[cfg(not(windows))]
fn login_shell_path(timeout: Duration) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let shell_name = PathBuf::from(&shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let shell_args = if matches!(shell_name.as_str(), "sh" | "dash" | "ash") {
        vec!["-ic", r#"printf '\036PATH=%s\036\n' "$PATH""#]
    } else {
        vec!["-ilc", r#"printf '\036PATH=%s\036\n' "$PATH""#]
    };
    let mut child = Command::new(&shell)
        .args(shell_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child.wait_with_output().ok()?;
                let stdout = String::from_utf8_lossy(&output.stdout);
                return parse_shell_path_output(&stdout);
            }
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
}

#[cfg(not(windows))]
fn parse_shell_path_output(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix(PATH_MARKER) {
            if let Some(val) = rest.strip_suffix(PATH_MARKER) {
                if let Some(path) = val.strip_prefix("PATH=") {
                    if !path.is_empty() {
                        return Some(path.to_string());
                    }
                }
            }
        }
    }
    None
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::{merge_child_path_env, parse_shell_path_output};

    #[test]
    fn parse_shell_path_output_ignores_banners() {
        let output = "Welcome\n\x1ePATH=/opt/homebrew/bin:/usr/bin\x1e\nGoodbye\n";
        assert_eq!(
            parse_shell_path_output(output).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn parse_shell_path_output_rejects_missing_or_empty_markers() {
        assert_eq!(parse_shell_path_output("PATH=/usr/bin"), None);
        assert_eq!(parse_shell_path_output("\x1ePATH=\x1e"), None);
        assert_eq!(parse_shell_path_output("\x1eOTHER=/usr/bin\x1e"), None);
    }

    #[test]
    fn merge_child_path_env_prepends_shell_path_when_inherited_path_exists() {
        assert_eq!(
            merge_child_path_env("/opt/homebrew/bin:/usr/local/bin", Some("/usr/bin:/bin")),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        );
    }

    #[test]
    fn merge_child_path_env_uses_shell_path_when_inherited_path_is_empty() {
        assert_eq!(
            merge_child_path_env("/opt/homebrew/bin", Some("")),
            "/opt/homebrew/bin"
        );
        assert_eq!(
            merge_child_path_env("/opt/homebrew/bin", None),
            "/opt/homebrew/bin"
        );
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::{find_windows_cli_command_with_env, windows_user_npm_bin_dir};
    use std::path::PathBuf;

    #[test]
    fn windows_user_npm_bin_dir_prefers_appdata() {
        let root = tempdir_for_test();
        let app_data = root.join("Roaming");
        let npm_dir = app_data.join("npm");
        std::fs::create_dir_all(&npm_dir).unwrap();

        assert_eq!(
            windows_user_npm_bin_dir(Some(&app_data), None),
            Some(npm_dir)
        );
    }

    #[test]
    fn windows_user_npm_bin_dir_falls_back_to_userprofile() {
        let root = tempdir_for_test();
        let user_profile = root.join("profile");
        let npm_dir = user_profile.join("AppData").join("Roaming").join("npm");
        std::fs::create_dir_all(&npm_dir).unwrap();

        assert_eq!(
            windows_user_npm_bin_dir(None, Some(&user_profile)),
            Some(npm_dir)
        );
    }

    #[test]
    fn finds_windows_cli_command_in_appdata_npm_even_without_path_lookup() {
        let root = tempdir_for_test();
        let app_data = root.join("Roaming");
        let npm_dir = app_data.join("npm");
        std::fs::create_dir_all(&npm_dir).unwrap();
        let shim = npm_dir.join("claude.cmd");
        std::fs::write(&shim, "@echo off").unwrap();

        let resolved = find_windows_cli_command_with_env(
            "claude",
            &["claude.exe".to_string(), "claude.cmd".to_string()],
            Some(&app_data),
            None,
        );

        assert_eq!(resolved, Some(shim));
    }

    #[test]
    fn finds_windows_powershell_shim_when_cmd_is_missing() {
        let root = tempdir_for_test();
        let app_data = root.join("Roaming");
        let npm_dir = app_data.join("npm");
        std::fs::create_dir_all(&npm_dir).unwrap();
        let shim = npm_dir.join("claude.ps1");
        std::fs::write(&shim, "Write-Output test").unwrap();

        let resolved = find_windows_cli_command_with_env(
            "claude",
            &["claude.exe".to_string(), "claude.cmd".to_string()],
            Some(&app_data),
            None,
        );

        assert_eq!(resolved, Some(shim));
    }

    fn tempdir_for_test() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qmai-cli-resolver-test-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
