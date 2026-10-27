mod account;
#[cfg(feature = "desktop")]
mod account_host;
#[cfg(feature = "desktop")]
mod downloads;
#[cfg(feature = "desktop")]
mod host;
mod media_proxy;
pub mod network;
mod offline_core;
mod offline_stream;
pub mod settings;
#[cfg(feature = "desktop")]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            host::show_main(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .register_asynchronous_uri_scheme_protocol("offline", |context, request, responder| {
            let state = context
                .app_handle()
                .state::<downloads::Downloads>()
                .inner()
                .clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(downloads::media_response(&state, request))
            });
        })
        .setup(|app| {
            app.manage(account::Account::new().map_err(std::io::Error::other)?);
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(
                settings::Settings::new(dir.join("settings.json"))
                    .map_err(std::io::Error::other)?,
            );
            app.manage(
                downloads::Downloads::new(dir.join("offline_storage"))
                    .map_err(std::io::Error::other)?,
            );
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_navigation(|url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                })
                .build()?;
            host::setup_tray(app.handle())?;
            host::setup_notifications(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window
                    .state::<settings::Settings>()
                    .get("MinimizeToTray")
                    .ok()
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true)
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            account_host::account_start,
            account_host::account_poll,
            account_host::account_cancel,
            account_host::account_status,
            account_host::account_logout,
            account_host::account_portal,
            account_host::friends_list,
            account_host::friends_lookup,
            account_host::friends_request,
            account_host::friends_accept,
            account_host::friends_reject,
            account_host::friends_remove,
            account_host::watch_invites_list,
            account_host::watch_invite_send,
            account_host::watch_invite_accept,
            account_host::watch_invite_decline,
            media_proxy::media_open,
            media_proxy::media_close,
            host::window_minimize,
            host::window_maximize,
            host::window_close,
            host::window_start_dragging,
            host::window_get_size,
            host::window_is_fullscreen,
            host::window_enter_fullscreen,
            host::window_leave_fullscreen,
            host::app_quit,
            host::power_sleep,
            host::power_shutdown,
            host::discord_set,
            host::discord_clear,
            host::runtime_versions,
            host::runtime_debug,
            host::open_link,
            host::notify_send,
            host::debug_send,
            host::updater_check,
            host::updater_install,
            settings::settings_get_all,
            settings::settings_get,
            settings::settings_set,
            settings::proxy_toggle,
            network::net_fetch,
            network::oauth_exchange,
            network::oauth_refresh,
            network::sibnet_parse,
            downloads::offline_open,
            downloads::offline_get_library,
            downloads::offline_get_active_downloads,
            downloads::offline_download_episode,
            downloads::offline_pause_download,
            downloads::offline_resume_download,
            downloads::offline_retry_download,
            downloads::offline_cancel_download,
            downloads::offline_delete_episode,
            downloads::offline_open_folder,
            downloads::download_episode
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run AnixArtix");
}
