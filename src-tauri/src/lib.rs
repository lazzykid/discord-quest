use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const DETECTABLE_URL: &str = "https://discord.com/api/v9/applications/detectable";

pub struct AppState {
    processes: Mutex<HashMap<u32, TrackedProcess>>,
    stash: Mutex<Vec<StashedSession>>,
    totals: Mutex<Totals>,
    games_cache: Mutex<Option<serde_json::Value>>,
}

#[derive(Clone)]
struct TrackedProcess {
    name: String,
    exe_path: PathBuf,
    started_at: u64,
    accumulated: u64,
}

#[derive(Serialize, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StashedSession {
    name: String,
    exe_path: String,
    accumulated: u64,
    stashed_at: u64,
}

#[derive(Serialize, Clone, Deserialize, Default)]
struct Totals {
    sec: u64,
    runs: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pid: u32,
    name: String,
    exe_path: String,
    started_at: u64,
    accumulated: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FarmState {
    totals: Totals,
    stash: Vec<StashedSession>,
}

// ── persistence ─────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct SavedTotals {
    sec: u64,
    runs: u64,
}

#[derive(Serialize, Deserialize)]
struct SavedSession {
    pid: u32,
    name: String,
    exe_path: String,
    started_at: u64,
    accumulated: u64,
}

#[derive(Serialize, Deserialize)]
struct SavedStash {
    name: String,
    exe_path: String,
    accumulated: u64,
    stashed_at: u64,
}

#[derive(Serialize, Deserialize)]
struct SavedState {
    updated_at: u64,
    totals: SavedTotals,
    sessions: Vec<SavedSession>,
    stash: Vec<SavedStash>,
}

impl Default for AppState {
    fn default() -> Self {
        let (processes, stash, totals) = load_saved();
        Self {
            processes: Mutex::new(processes),
            stash: Mutex::new(stash),
            totals: Mutex::new(totals),
            games_cache: Mutex::new(None),
        }
    }
}

impl AppState {
    fn saved_state(&self, updated_at: u64) -> SavedState {
        let processes = self
            .processes
            .lock()
            .map(|map| {
                map.iter()
                    .map(|(pid, t)| SavedSession {
                        pid: *pid,
                        name: t.name.clone(),
                        exe_path: t.exe_path.display().to_string(),
                        started_at: t.started_at,
                        accumulated: t.accumulated,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let stash = self
            .stash
            .lock()
            .map(|list| {
                list.iter()
                    .map(|s| SavedStash {
                        name: s.name.clone(),
                        exe_path: s.exe_path.clone(),
                        accumulated: s.accumulated,
                        stashed_at: s.stashed_at,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let totals = self.totals.lock().map(|t| t.clone()).unwrap_or_default();
        SavedState {
            updated_at,
            totals: SavedTotals {
                sec: totals.sec,
                runs: totals.runs,
            },
            sessions: processes,
            stash,
        }
    }

    fn persist(&self) {
        let state = self.saved_state(now_unix());
        let file = state_file();
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&state) {
            let _ = std::fs::write(&file, json);
        }
    }

    fn bank(&self, sec: u64) {
        if sec == 0 {
            return;
        }
        if let Ok(mut t) = self.totals.lock() {
            t.sec += sec;
            t.runs += 1;
        }
    }
}

fn state_file() -> PathBuf {
    games_root()
        .parent()
        .map(|p| p.join("sessions.json"))
        .unwrap_or_else(|| games_root().join("sessions.json"))
}

fn load_saved() -> (HashMap<u32, TrackedProcess>, Vec<StashedSession>, Totals) {
    let mut processes = HashMap::new();
    let mut stash: Vec<StashedSession> = Vec::new();
    let mut totals = Totals::default();

    let Ok(text) = std::fs::read_to_string(state_file()) else {
        return (processes, stash, totals);
    };
    let Ok(saved) = serde_json::from_str::<SavedState>(&text) else {
        return (processes, stash, totals);
    };

    totals = Totals {
        sec: saved.totals.sec,
        runs: saved.totals.runs,
    };

    for s in saved.sessions {
        let exe_path = PathBuf::from(&s.exe_path);
        // still alive after a restart (fakes outlive the app) — adopt it,
        // timer keeps running
        if win::process_matches(s.pid, &exe_path) {
            processes.insert(
                s.pid,
                TrackedProcess {
                    name: s.name,
                    exe_path,
                    started_at: s.started_at,
                    accumulated: s.accumulated,
                },
            );
        } else {
            // died while we were away — stash what it reached so it can be resumed
            let elapsed =
                s.accumulated + saved.updated_at.saturating_sub(s.started_at);
            stash.push(StashedSession {
                name: s.name,
                exe_path: s.exe_path,
                accumulated: elapsed,
                stashed_at: now_unix(),
            });
        }
    }
    for s in saved.stash {
        stash.push(StashedSession {
            name: s.name,
            exe_path: s.exe_path,
            accumulated: s.accumulated,
            stashed_at: s.stashed_at,
        });
    }

    (processes, stash, totals)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn games_root() -> PathBuf {
    // not %TEMP%: cleaners wipe it and some AV heuristics flag exes that run from there
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("DiscordQuest").join("games")
}

fn resolve_game_exe_path(exe_name: &str) -> Result<PathBuf, String> {
    let rel = exe_name.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err("Executable name is empty".into());
    }
    if rel.contains(':') || Path::new(&rel).is_absolute() {
        return Err("Executable path must be relative".into());
    }
    let mut dest = games_root();
    for part in rel.split('/') {
        if part.is_empty() {
            continue;
        }
        if part == "." || part == ".." {
            return Err("Invalid executable path".into());
        }
        if part.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*')) {
            return Err("Invalid character in executable path".into());
        }
        dest.push(part);
    }
    if dest.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("exe")) != Some(true)
    {
        dest.set_extension("exe");
    }
    Ok(dest)
}

/// game_host.exe gets copied under the game's name before launch.
/// notepad.exe is the last-ditch fallback so launch works even without a build.
fn host_source() -> PathBuf {
    host_source_candidates()
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| {
            let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
            PathBuf::from(windir).join("System32").join("notepad.exe")
        })
}

fn host_source_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("game_host.exe"));
            out.push(dir.join("bin").join("game_host.exe"));
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let target = manifest.parent().unwrap_or(&manifest).join("target");
    if cfg!(debug_assertions) {
        out.push(target.join("debug").join("game_host.exe"));
        out.push(target.join("release").join("game_host.exe"));
    } else {
        out.push(target.join("release").join("game_host.exe"));
        out.push(target.join("debug").join("game_host.exe"));
    }
    out
}

fn ensure_stub(dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create game folder: {e}"))?;
    }
    let source = host_source();
    if !source.exists() {
        return Err(format!("Host binary not found: {}", source.display()));
    }
    std::fs::copy(&source, dest).map_err(|e| {
        format!(
            "Failed to write {} as {}: {e}",
            dest.file_name().and_then(|n| n.to_str()).unwrap_or("game.exe"),
            dest.display()
        )
    })?;
    Ok(())
}

fn spawn_tracked(
    state: &AppState,
    dest: PathBuf,
    title: String,
    accumulated: u64,
) -> Result<u32, String> {
    ensure_stub(&dest)?;
    // Best-effort: give the process a real window named after the game.
    let pid = win::spawn_visible_no_activate(&dest)?;
    let _ = win::tame_window(pid, &title);
    let started_at = now_unix();
    {
        let mut map = state
            .processes
            .lock()
            .map_err(|_| "Process state is locked".to_string())?;
        map.insert(
            pid,
            TrackedProcess {
                name: title,
                exe_path: dest,
                started_at,
                accumulated,
            },
        );
    }
    state.persist();
    Ok(pid)
}

#[cfg(windows)]
mod win {
    use std::path::Path;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, CREATE_NEW_PROCESS_GROUP, CREATE_UNICODE_ENVIRONMENT,
        PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE, STARTF_USESHOWWINDOW, STARTUPINFOW, TerminateProcess, OpenProcess,
        QueryFullProcessImageNameW, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetAncestor, GetWindowLongPtrW, GetWindowThreadProcessId, IsWindowVisible,
        SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow, GA_ROOT, GWL_EXSTYLE,
        SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };

    // Windows keeps minimized apps at this X; nothing renders on screen there.
    const OFFSCREEN_X: i32 = -32000;
    const OFFSCREEN_Y: i32 = -32000;

    pub fn spawn_visible_no_activate(exe: &Path) -> Result<u32, String> {
        use std::os::windows::ffi::OsStrExt;

        let cwd = exe.parent().unwrap_or(Path::new("."));
        let cwd_wide: Vec<u16> = cwd.as_os_str().encode_wide().chain([0]).collect();
        let mut quoted: Vec<u16> = std::iter::once('"' as u16)
            .chain(exe.as_os_str().encode_wide())
            .chain(['"' as u16, 0])
            .collect();

        let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_SHOWNOACTIVATE as u16;

        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            CreateProcessW(
                std::ptr::null(),
                quoted.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
                std::ptr::null(),
                cwd_wide.as_ptr(),
                &si,
                &mut pi,
            )
        };
        if ok == 0 {
            return Err(format!(
                "Failed to start game process: {}",
                std::io::Error::last_os_error()
            ));
        }
        unsafe {
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
        }
        Ok(pi.dwProcessId)
    }

    struct EnumState {
        pid: u32,
        found: Option<HWND>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam as LPARAM as *mut EnumState);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == state.pid
            && IsWindowVisible(hwnd) != 0
            && GetAncestor(hwnd, GA_ROOT) == hwnd
        {
            state.found = Some(hwnd);
            return 0;
        }
        1
    }

    fn find_main_window(pid: u32) -> Option<HWND> {
        let mut state = EnumState { pid, found: None };
        unsafe { EnumWindows(Some(enum_proc), &mut state as *mut EnumState as LPARAM) };
        state.found
    }

    // real window, just off-screen with no taskbar button — enough for the
    // scanner, invisible to the user
    pub fn tame_window(pid: u32, title: &str) -> bool {
        for _ in 0..40 {
            if let Some(hwnd) = find_main_window(pid) {
                unsafe {
                    let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                    SetWindowLongPtrW(
                        hwnd,
                        GWL_EXSTYLE,
                        style | (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) as isize,
                    );
                    let title_wide: Vec<u16> = title
                        .encode_utf16()
                        .chain(Some(0))
                        .collect();
                    SetWindowTextW(hwnd, title_wide.as_ptr());
                    SetWindowPos(
                        hwnd,
                        1 as HWND,
                        OFFSCREEN_X,
                        OFFSCREEN_Y,
                        0,
                        0,
                        SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
                    );
                    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                }
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// PID alive AND its image path is the one we saved (guards against PID reuse).
    pub fn process_matches(pid: u32, exe_path: &Path) -> bool {
        unsafe {
            let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(handle);
            if ok == 0 {
                return false;
            }
            let image = String::from_utf16_lossy(&buf[..len as usize]);
            image.eq_ignore_ascii_case(&exe_path.display().to_string())
        }
    }

    pub fn terminate_pid(pid: u32) -> Result<(), String> {
        unsafe {
            let handle: HANDLE =
                OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return Err(format!("Could not open PID {pid}"));
            }
            let ok = TerminateProcess(handle, 1);
            if ok != 0 {
                // TerminateProcess is async: wait so the exe file is unlocked
                // by the time the caller tries to delete it.
                WaitForSingleObject(handle, 5000);
            }
            CloseHandle(handle);
            if ok == 0 {
                return Err(format!("Could not terminate PID {pid}"));
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod win {
    use std::path::Path;

    pub fn spawn_visible_no_activate(exe: &Path) -> Result<u32, String> {
        let child = std::process::Command::new(exe)
            .current_dir(exe.parent().unwrap_or(Path::new(".")))
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(child.id())
    }

    pub fn tame_window(_pid: u32, _title: &str) -> bool {
        true
    }

    pub fn process_matches(pid: u32, _exe_path: &Path) -> bool {
        std::path::Path::new("/proc").join(pid.to_string()).exists()
    }

    pub fn terminate_pid(pid: u32) -> Result<(), String> {
        let status = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("kill failed for PID {pid}"));
        }
        Ok(())
    }
}

#[tauri::command]
fn get_detectable_games(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    {
        let cache = state
            .games_cache
            .lock()
            .map_err(|_| "Game cache is locked".to_string())?;
        if let Some(value) = cache.as_ref() {
            return Ok(value.clone());
        }
    }

    let body = ureq::get(DETECTABLE_URL)
        .set("User-Agent", "DiscordQuest/0.1")
        .call()
        .map_err(|e| format!("Failed to load Discord catalog: {e}"))?
        .into_string()
        .map_err(|e| format!("Failed to read Discord response: {e}"))?;

    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid Discord JSON: {e}"))?;

    *state
        .games_cache
        .lock()
        .map_err(|_| "Game cache is locked".to_string())? = Some(value.clone());

    Ok(value)
}

#[tauri::command]
fn start_dummy_process(
    state: tauri::State<AppState>,
    exe_name: String,
    game_name: String,
) -> Result<u32, String> {
    let dest = resolve_game_exe_path(&exe_name)?;

    {
        let map = state
            .processes
            .lock()
            .map_err(|_| "Process state is locked".to_string())?;
        // one instance per game exe
        if let Some((&pid, _)) = map.iter().find(|(_, t)| t.exe_path == dest) {
            return Err(format!(
                "{} is already running (PID {})",
                if game_name.trim().is_empty() { exe_name } else { game_name },
                pid
            ));
        }
    }

    let title = if game_name.trim().is_empty() { exe_name } else { game_name };
    // Launching fresh clears any stashed leftover for the same executable.
    {
        let mut stash = state
            .stash
            .lock()
            .map_err(|_| "Stash is locked".to_string())?;
        stash.retain(|s| !s.exe_path.eq_ignore_ascii_case(&dest.display().to_string()));
    }
    let pid = spawn_tracked(&state, dest, title, 0)?;
    Ok(pid)
}

#[tauri::command]
fn resume_stashed_process(state: tauri::State<AppState>, exe_path: String) -> Result<u32, String> {
    let stashed = {
        let mut stash = state
            .stash
            .lock()
            .map_err(|_| "Stash is locked".to_string())?;
        let pos = stash
            .iter()
            .position(|s| s.exe_path.eq_ignore_ascii_case(&exe_path))
            .ok_or_else(|| "Stashed session not found".to_string())?;
        stash.remove(pos)
    };

    let dest = PathBuf::from(&stashed.exe_path);
    let adopted_pid = {
        let map = state
            .processes
            .lock()
            .map_err(|_| "Process state is locked".to_string())?;
        map.iter()
            .find(|(_, t)| t.exe_path == dest)
            .map(|(&pid, _)| pid)
    };

    if let Some(pid) = adopted_pid {
        // Came back alive on its own — keep tracking, drop the stash copy.
        state.persist();
        return Ok(pid);
    }

    spawn_tracked(&state, dest, stashed.name, stashed.accumulated)
}

#[tauri::command]
fn drop_stashed_process(state: tauri::State<AppState>, exe_path: String) -> Result<(), String> {
    let dropped = {
        let mut stash = state
            .stash
            .lock()
            .map_err(|_| "Stash is locked".to_string())?;
        let pos = stash
            .iter()
            .position(|s| s.exe_path.eq_ignore_ascii_case(&exe_path))
            .ok_or_else(|| "Stashed session not found".to_string())?;
        stash.remove(pos)
    };
    // The run never made it to a proper stop — bank what it reached.
    state.bank(dropped.accumulated);
    state.persist();
    Ok(())
}

#[tauri::command]
fn get_farm_state(state: tauri::State<AppState>) -> Result<FarmState, String> {
    let totals = state
        .totals
        .lock()
        .map_err(|_| "Totals are locked".to_string())?
        .clone();
    let stash = state
        .stash
        .lock()
        .map_err(|_| "Stash is locked".to_string())?
        .clone();
    Ok(FarmState { totals, stash })
}

#[tauri::command]
fn stop_dummy_process(state: tauri::State<AppState>, pid: u32) -> Result<(), String> {
    let mut map = state
        .processes
        .lock()
        .map_err(|_| "Process state is locked".to_string())?;

    if let Some(tracked) = map.remove(&pid) {
        drop(map);
        win::terminate_pid(pid)?;
        let _ = std::fs::remove_file(&tracked.exe_path);
        state.bank(tracked.accumulated + now_unix().saturating_sub(tracked.started_at));
        state.persist();
        return Ok(());
    }

    win::terminate_pid(pid)
}

#[tauri::command]
fn list_processes(state: tauri::State<AppState>) -> Result<Vec<ProcessInfo>, String> {
    let mut map = state
        .processes
        .lock()
        .map_err(|_| "Process state is locked".to_string())?;

    // reaped = the process died on its own; stash it so it can be resumed
    let dead: Vec<(u32, TrackedProcess)> = map
        .iter()
        .filter(|(pid, t)| !win::process_matches(**pid, &t.exe_path))
        .map(|(pid, t)| (*pid, t.clone()))
        .collect();
    let mut reaped = false;
    for (pid, tracked) in dead {
        map.remove(&pid);
        if let Ok(mut stash) = state.stash.lock() {
            stash.push(StashedSession {
                name: tracked.name,
                exe_path: tracked.exe_path.display().to_string(),
                accumulated: tracked.accumulated + now_unix().saturating_sub(tracked.started_at),
                stashed_at: now_unix(),
            });
        }
        reaped = true;
    }
    drop(map);
    if reaped {
        state.persist();
    }

    let map = state
        .processes
        .lock()
        .map_err(|_| "Process state is locked".to_string())?;

    Ok(map
        .iter()
        .map(|(pid, tracked)| ProcessInfo {
            pid: *pid,
            name: tracked.name.clone(),
            exe_path: tracked.exe_path.display().to_string(),
            started_at: tracked.started_at,
            accumulated: tracked.accumulated,
        })
        .collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_detectable_games,
            start_dummy_process,
            stop_dummy_process,
            list_processes,
            resume_stashed_process,
            drop_stashed_process,
            get_farm_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
