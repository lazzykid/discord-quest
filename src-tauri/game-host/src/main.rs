// Tiny GUI stub: creates a real (but off-screen, non-activating) top-level
// window titled after the game. Discord's process scanner sees both the
// executable image name and a live window, which is what makes a process
// look like a running game. The main app copies this binary under the
// game's executable name before launching it.
#![windows_subsystem = "windows"]

#[cfg(windows)]
fn main() {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, RegisterClassW, ShowWindow,
        TranslateMessage, MSG, SW_SHOWNOACTIVATE, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_POPUP, WS_VISIBLE,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    let title = std::env::args().nth(1).unwrap_or_else(|| "game".into());
    let title_wide = wide(&title);

    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let class_name = wide("DiscordQuestHostWnd");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(windows_sys::Win32::UI::WindowsAndMessaging::DefWindowProcW),
            hInstance: hinstance,
            lpszClassName: class_name.as_ptr(),
            ..std::mem::zeroed()
        };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) as u32,
            class_name.as_ptr(),
            title_wide.as_ptr(),
            (WS_POPUP | WS_VISIBLE) as u32,
            -32000,
            -32000,
            240,
            64,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null(),
        );
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    // Non-Windows hosts just idle; detection there is not supported anyway.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
