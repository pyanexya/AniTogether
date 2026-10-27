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

use crate::account::social::*;
#[tauri::command]
pub async fn friends_list(state: State<'_, Account>) -> Result<Friends, String> {
    state.friends_list().await
}
#[tauri::command]
pub async fn friends_lookup(state: State<'_, Account>, username: String) -> Result<Lookup, String> {
    state.friends_lookup(&username).await
}
#[tauri::command]
pub async fn friends_request(
    state: State<'_, Account>,
    user_id: String,
) -> Result<Created, String> {
    state.friends_request(&user_id).await
}
#[tauri::command]
pub async fn friends_accept(state: State<'_, Account>, request_id: String) -> Result<Done, String> {
    state.friends_accept(&request_id).await
}
#[tauri::command]
pub async fn friends_reject(state: State<'_, Account>, request_id: String) -> Result<Done, String> {
    state.friends_reject(&request_id).await
}
#[tauri::command]
pub async fn friends_remove(state: State<'_, Account>, user_id: String) -> Result<Done, String> {
    state.friends_remove(&user_id).await
}
#[tauri::command]
pub async fn watch_invites_list(state: State<'_, Account>) -> Result<Invites, String> {
    state.watch_invites_list().await
}
#[tauri::command]
pub async fn watch_invite_send(
    state: State<'_, Account>,
    recipient_id: String,
    room_id: String,
    host_token: String,
) -> Result<SentInvite, String> {
    state
        .watch_invite_send(&recipient_id, &room_id, &host_token)
        .await
}
#[tauri::command]
pub async fn watch_invite_accept(
    state: State<'_, Account>,
    invite_id: String,
) -> Result<AcceptedInvite, String> {
    state.watch_invite_accept(&invite_id).await
}
#[tauri::command]
pub async fn watch_invite_decline(
    state: State<'_, Account>,
    invite_id: String,
) -> Result<Done, String> {
    state.watch_invite_decline(&invite_id).await
}
