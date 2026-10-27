//! Allowlisted, typed social API. Account bearer tokens never leave the native host.
use super::*;
use reqwest::Method;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequest {
    pub id: String,
    pub profile: Profile,
    pub created_at: u64,
}
#[derive(Serialize, Deserialize)]
pub struct Friends {
    pub friends: Vec<Profile>,
    pub incoming: Vec<FriendRequest>,
    pub outgoing: Vec<FriendRequest>,
}
#[derive(Serialize, Deserialize)]
pub struct Lookup {
    pub profile: Profile,
}
#[derive(Serialize, Deserialize)]
pub struct Created {
    pub id: String,
}
#[derive(Serialize, Deserialize)]
pub struct Done {
    pub ok: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub id: String,
    pub sender: Profile,
    pub created_at: u64,
    pub expires_at: u64,
}
#[derive(Serialize, Deserialize)]
pub struct Invites {
    pub invites: Vec<Invite>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentInvite {
    pub id: String,
    pub expires_at: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedInvite {
    pub server_url: String,
    pub room_id: String,
    pub invite_token: String,
}
fn identifier(v: &str, min: usize, max: usize) -> Result<(), String> {
    if (min..=max).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Ok(())
    } else {
        Err("Неверный идентификатор".into())
    }
}
fn hex(v: &str, len: usize) -> bool {
    v.len() == len
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Account {
    async fn social<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T, String> {
        let (generation, session) = {
            let state = self.state.lock().unwrap();
            (
                state.generation,
                state.session.clone().ok_or("Войдите в AnixArtix")?,
            )
        };
        if !token_valid(&session) {
            self.cancel_session(generation);
            return Err("Сессия истекла. Войдите заново.".into());
        }
        let result = self
            .request_method(method, path, body, Some(&session.token))
            .await;
        if self.state.lock().unwrap().generation != generation {
            return Err("Сессия изменилась".into());
        }
        let (status, value) = result?;
        if status == 401 {
            self.cancel_session(generation);
            return Err(status_error(status));
        }
        if !(200..300).contains(&status) {
            return Err(match status {
                400 => "Проверьте ник или данные приглашения.",
                403 => "Сначала добавьте пользователя в друзья.",
                404 => "Пользователь, заявка или приглашение не найдены.",
                409 => "Заявка уже существует, достигнут лимит или комната недоступна.",
                _ => return Err(status_error(status)),
            }
            .into());
        }
        // Deserialize into explicit public fields; unknown credentials are discarded recursively.
        let output =
            serde_json::from_value(value).map_err(|_| "Неверный ответ сервиса".to_string())?;
        if self.state.lock().unwrap().generation != generation {
            return Err("Сессия изменилась".into());
        }
        Ok(output)
    }
    pub async fn friends_list(&self) -> Result<Friends, String> {
        self.social(Method::GET, "/api/friends", None).await
    }
    pub async fn friends_lookup(&self, username: &str) -> Result<Lookup, String> {
        if !(3..=24).contains(&username.len())
            || !username
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err("Ник: от 3 до 24 букв, цифр или _".into());
        }
        self.social(
            Method::GET,
            &format!("/api/friends/lookup?username={username}"),
            None,
        )
        .await
    }
    pub async fn friends_request(&self, user_id: &str) -> Result<Created, String> {
        identifier(user_id, 1, 128)?;
        self.social(
            Method::POST,
            "/api/friends/requests",
            Some(json!({"userId":user_id})),
        )
        .await
    }
    pub async fn friends_accept(&self, request_id: &str) -> Result<Done, String> {
        identifier(request_id, 43, 43)?;
        self.social(
            Method::POST,
            &format!("/api/friends/requests/{request_id}/accept"),
            Some(json!({})),
        )
        .await
    }
    pub async fn friends_reject(&self, request_id: &str) -> Result<Done, String> {
        identifier(request_id, 43, 43)?;
        self.social(
            Method::POST,
            &format!("/api/friends/requests/{request_id}/reject"),
            Some(json!({})),
        )
        .await
    }
    pub async fn friends_remove(&self, user_id: &str) -> Result<Done, String> {
        identifier(user_id, 1, 128)?;
        self.social(Method::DELETE, &format!("/api/friends/{user_id}"), None)
            .await
    }
    pub async fn watch_invites_list(&self) -> Result<Invites, String> {
        self.social(Method::GET, "/api/watch-invites", None).await
    }
    pub async fn watch_invite_send(
        &self,
        recipient_id: &str,
        room_id: &str,
        host_token: &str,
    ) -> Result<SentInvite, String> {
        identifier(recipient_id, 1, 128)?;
        if !hex(room_id, 12) || !hex(host_token, 48) {
            return Err("Неверные данные комнаты".into());
        }
        self.social(
            Method::POST,
            "/api/watch-invites",
            Some(json!({"recipientId":recipient_id,"roomId":room_id,"hostToken":host_token})),
        )
        .await
    }
    pub async fn watch_invite_accept(&self, invite_id: &str) -> Result<AcceptedInvite, String> {
        identifier(invite_id, 43, 43)?;
        let accepted: AcceptedInvite = self
            .social(
                Method::POST,
                &format!("/api/watch-invites/{invite_id}/accept"),
                Some(json!({})),
            )
            .await?;
        if accepted.server_url != "wss://aniartix.pyanexy.cc/watch"
            || !hex(&accepted.room_id, 12)
            || !hex(&accepted.invite_token, 48)
        {
            return Err("Неверные данные приглашения".into());
        }
        Ok(accepted)
    }
    pub async fn watch_invite_decline(&self, invite_id: &str) -> Result<Done, String> {
        identifier(invite_id, 43, 43)?;
        self.social(
            Method::POST,
            &format!("/api/watch-invites/{invite_id}/decline"),
            Some(json!({})),
        )
        .await
    }
}
