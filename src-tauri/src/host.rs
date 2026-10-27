use crate::settings::Settings;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Untrusted window".into())
    }
}
#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    main_window(&window)?;
    window.minimize().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn window_maximize(window: WebviewWindow) -> Result<(), String> {
    main_window(&window)?;
    if window.is_fullscreen().map_err(|e| e.to_string())? {
        return fullscreen(window, false);
    } else if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize()
    } else {
        window.maximize()
    }
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<(), String> {
    main_window(&window)?;
    window.close().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn window_start_dragging(window: WebviewWindow) -> Result<(), String> {
    main_window(&window)?;
    window.start_dragging().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn window_get_size(window: WebviewWindow) -> Result<[f64; 2], String> {
    let s = window
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    Ok([s.width, s.height])
}
#[tauri::command]
pub fn window_is_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    window.is_fullscreen().map_err(|e| e.to_string())
}
fn fullscreen(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_fullscreen(enabled).map_err(|e| e.to_string())?;
    window
        .emit("fullscreen:changed", enabled)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn window_enter_fullscreen(window: WebviewWindow) -> Result<(), String> {
    fullscreen(window, true)
}
#[tauri::command]
pub fn window_leave_fullscreen(window: WebviewWindow) -> Result<(), String> {
    fullscreen(window, false)
}
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0)
}
#[tauri::command]
pub fn power_sleep() -> Result<(), String> {
    Err("Сон компьютера пока недоступен в Tauri-версии. Используйте меню Windows.".into())
}
#[tauri::command]
pub fn power_shutdown() -> Result<(), String> {
    Err("Выключение компьютера пока недоступно в Tauri-версии. Используйте меню Windows.".into())
}
#[tauri::command]
pub fn discord_set(activity: Option<Value>) -> Result<(), String> {
    let _ = activity;
    Err("Discord Rich Presence пока недоступен в Tauri-версии.".into())
}
#[tauri::command]
pub fn discord_clear() -> Result<(), String> {
    Err("Discord Rich Presence пока недоступен в Tauri-версии.".into())
}
#[tauri::command]
pub fn runtime_versions() -> Value {
    json!({"runtime":"tauri","tauri":"2","anidesk":env!("CARGO_PKG_VERSION"),"anixartix":env!("CARGO_PKG_VERSION"),"webview":"Microsoft Edge WebView2","isDebug":cfg!(debug_assertions),"capabilities":{"discord":false,"power":false,"notifications":true,"offline":true,"devtools":false,"cdnProxy":false,"notificationNavigation":true}})
}
#[tauri::command]
pub fn runtime_debug() -> bool {
    cfg!(debug_assertions)
}
#[tauri::command]
pub fn open_link(app: AppHandle, link: String) -> Result<bool, String> {
    crate::network::validate_url(&link)?;
    app.opener()
        .open_url(link, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(true)
}
#[tauri::command]
pub fn notify_send(app: AppHandle, data: Value) -> Result<bool, String> {
    if !app
        .state::<Settings>()
        .get("EnableEpisodeNotifications")?
        .as_bool()
        .unwrap_or(true)
    {
        return Ok(false);
    }
    let title = data
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("AnixArtix");
    let body = data.get("body").and_then(Value::as_str).unwrap_or("");
    if title.len() > 256 || body.len() > 4096 {
        return Err("Notification too long".into());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .extra(
            "releaseId",
            data.get("releaseId")
                .filter(|v| v.as_u64().is_some_and(|id| id > 0))
                .cloned(),
        )
        .show()
        .map_err(|e| e.to_string())?;
    Ok(true)
}
#[tauri::command]
pub fn debug_send(app: AppHandle, data: Value) -> Result<(), String> {
    // Never forward arbitrary account payloads, signed URLs, or secrets to persistent logs.
    if cfg!(debug_assertions) {
        let kind = data.get("type").and_then(Value::as_str).unwrap_or("info");
        if !["info", "warn", "error", "debug", "log"].contains(&kind) {
            return Err("Invalid log kind".into());
        }
        app.emit("debug:log",json!({"type":kind,"message":"Renderer diagnostic received (payload redacted)","data":null})).map_err(|e|e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn updater_check(app: AppHandle) -> Result<Value, String> {
    let status = json!({"status":"disabled","currentVersion":env!("CARGO_PKG_VERSION"),"text":"Автообновления отключены: канал AnixArtix ещё не настроен."});
    app.emit("updater:status", &status)
        .map_err(|e| e.to_string())?;
    Ok(status)
}
#[tauri::command]
pub fn updater_install() -> bool {
    false
}
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let show = MenuItem::with_id(app, "show", "Показать AnixArtix", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("AnixArtix")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn setup_notifications(app: &AppHandle) {
    let app = app.clone();
    let handler_app = app.clone();
    app.notification().on_action(move |action| {
        if action.action_id() != "tap" {
            return;
        }
        show_main(&handler_app);
        if let Some(release) = action
            .notification()
            .and_then(|n| n.extra().get("releaseId"))
            .and_then(Value::as_u64)
            .filter(|id| *id > 0)
        {
            let _ = handler_app.emit("navigate:release", release);
        }
    });
}
