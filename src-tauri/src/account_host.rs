use crate::account::{Account, Pairing, ISSUER};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
#[tauri::command]
pub async fn account_start(
    app: AppHandle,
    state: State<'_, Account>,
    remember: bool,
) -> Result<Pairing, String> {
    let pairing = state.start(remember).await?;
    // URL was checked for exact HTTPS issuer/path/grant in core, never provided by JS.
    if app
        .opener()
        .open_url(&pairing.verification_url, None::<&str>)
        .is_err()
    {
        state.cancel();
        return Err("Не удалось открыть системный браузер".into());
    }
    Ok(pairing)
}
#[tauri::command]
pub async fn account_poll(
    state: State<'_, Account>,
    attempt_id: String,
) -> Result<serde_json::Value, String> {
    state.poll(&attempt_id).await
}
#[tauri::command]
pub fn account_cancel(state: State<'_, Account>) {
    state.cancel();
}
#[tauri::command]
pub async fn account_status(state: State<'_, Account>) -> Result<serde_json::Value, String> {
    state.status().await
}
#[tauri::command]
pub async fn account_logout(state: State<'_, Account>) -> Result<serde_json::Value, String> {
    state.logout().await
}
#[tauri::command]
pub fn account_portal(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(format!("{ISSUER}/"), None::<&str>)
        .map_err(|_| "Не удалось открыть системный браузер".into())
}
