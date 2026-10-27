pub mod social;
// Independent AnixArtix identity. Never shares Anixart credentials or room URLs.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const ISSUER: &str = "https://aniartix.pyanexy.cc";
#[cfg(all(windows, feature = "desktop"))]
const VAULT_SERVICE: &str = "AnixArtix account https://aniartix.pyanexy.cc";
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
#[derive(Clone, Serialize, Deserialize)]
struct Session {
    issuer: String,
    token: String,
    expires_at: u64,
}
pub trait Vault: Send + Sync {
    fn read(&self) -> Result<Option<String>, ()>;
    fn write(&self, value: &str) -> Result<(), ()>;
    fn clear(&self) -> Result<(), ()>;
}
pub struct SystemVault;
#[cfg(all(windows, feature = "desktop"))]
impl Vault for SystemVault {
    fn read(&self) -> Result<Option<String>, ()> {
        match keyring::Entry::new(VAULT_SERVICE, "session")
            .map_err(|_| ())?
            .get_password()
        {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }
    fn write(&self, value: &str) -> Result<(), ()> {
        keyring::Entry::new(VAULT_SERVICE, "session")
            .map_err(|_| ())?
            .set_password(value)
            .map_err(|_| ())
    }
    fn clear(&self) -> Result<(), ()> {
        match keyring::Entry::new(VAULT_SERVICE, "session")
            .map_err(|_| ())?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}
#[cfg(not(all(windows, feature = "desktop")))]
impl Vault for SystemVault {
    fn read(&self) -> Result<Option<String>, ()> {
        Err(())
    }
    fn write(&self, _: &str) -> Result<(), ()> {
        Err(())
    }
    fn clear(&self) -> Result<(), ()> {
        Err(())
    }
}
struct Pending {
    id: String,
    grant: String,
    verifier: String,
    deadline: Instant,
    next_poll: Instant,
    busy: bool,
    remember: bool,
}
#[derive(Default)]
struct State {
    generation: u64,
    session: Option<Session>,
    pending: Option<Pending>,
    warning: Option<String>,
}
pub struct Account {
    state: Mutex<State>,
    client: reqwest::Client,
    vault: Box<dyn Vault>,
    #[cfg(test)]
    replies: Mutex<std::collections::VecDeque<(u16, Value)>>,
    #[cfg(test)]
    gate: Mutex<Option<std::sync::Arc<tokio::sync::Notify>>>,
    #[cfg(test)]
    requests: Mutex<Vec<(String, String, Option<Value>, bool)>>,
    #[cfg(test)]
    late_revocations: std::sync::atomic::AtomicUsize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub attempt_id: String,
    pub pairing_code: String,
    pub expires_in: u64,
    pub interval: u64,
    #[serde(skip)]
    pub verification_url: String,
}
fn warning() -> String {
    "Хранилище Windows недоступно: сессия только в памяти. Сохранённые ранее данные могли остаться в хранилище.".into()
}
fn token_valid(s: &Session) -> bool {
    s.issuer == ISSUER
        && s.expires_at > now()
        && !s.token.is_empty()
        && s.token.len() <= 4096
        && s.token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn verification_url(value: &str, grant: &str) -> bool {
    value == format!("{ISSUER}/desktop#grant={grant}")
        && grant.len() == 43
        && grant
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn pkce() -> (String, String) {
    let mut bytes = Vec::with_capacity(48);
    for _ in 0..3 {
        bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}
impl Account {
    pub fn new() -> Result<Self, String> {
        Self::with_vault(Box::new(SystemVault))
    }
    fn with_vault(vault: Box<dyn Vault>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "Не удалось создать клиент аккаунта")?;
        let mut state = State::default();
        match vault.read() {
            Ok(Some(v)) => {
                state.session = serde_json::from_str::<Session>(&v).ok().filter(token_valid);
                if state.session.is_none() && vault.clear().is_err() {
                    state.warning = Some(warning());
                }
            }
            Ok(None) => {}
            Err(_) => state.warning = Some(warning()),
        }
        Ok(Self {
            state: Mutex::new(state),
            client,
            vault,
            #[cfg(test)]
            replies: Mutex::new(std::collections::VecDeque::new()),
            #[cfg(test)]
            gate: Mutex::new(None),
            #[cfg(test)]
            requests: Mutex::new(Vec::new()),
            #[cfg(test)]
            late_revocations: std::sync::atomic::AtomicUsize::new(0),
        })
    }
    async fn request(
        &self,
        path: &str,
        body: Option<Value>,
        token: Option<&str>,
    ) -> Result<(u16, Value), String> {
        let method = if body.is_some() {
            reqwest::Method::POST
        } else {
            reqwest::Method::GET
        };
        self.request_method(method, path, body, token).await
    }
    async fn request_method(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        token: Option<&str>,
    ) -> Result<(u16, Value), String> {
        // Paths are fixed routes plus validated identifiers, never arbitrary IPC URLs.
        #[cfg(test)]
        {
            self.requests.lock().unwrap().push((
                method.to_string(),
                path.into(),
                body,
                token.is_some(),
            ));
            let gate = self.gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.notified().await;
            }
            return self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or("Offline test transport".into());
        }
        #[cfg(not(test))]
        {
            let mut request = self.client.request(method, format!("{ISSUER}{path}"));
            if let Some(body) = body {
                request = request.json(&body);
            }
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            let response = request.send().await.map_err(|_| {
                "Нет связи с сервисом аккаунтов. Анонимный просмотр доступен.".to_string()
            })?;
            let status = response.status().as_u16();
            let mut response = response;
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "Ошибка ответа сервиса")?
            {
                if bytes.len() + chunk.len() > 65536 {
                    return Err("Слишком большой ответ сервиса".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            Ok((status, value))
        }
    }
    pub fn cancel(&self) {
        let mut s = self.state.lock().unwrap();
        s.generation += 1;
        s.pending = None;
    }
    pub async fn start(&self, remember: bool) -> Result<Pairing, String> {
        let generation = {
            let mut s = self.state.lock().unwrap();
            s.generation += 1;
            s.pending = None;
            s.generation
        };
        let (verifier, challenge) = pkce();
        let (status, value) = self
            .request(
                "/api/desktop/start",
                Some(json!({"challenge":challenge})),
                None,
            )
            .await?;
        if status != 201 {
            return Err(status_error(status));
        }
        let grant = value["grant"].as_str().unwrap_or("").to_string();
        let url = value["verificationUrl"].as_str().unwrap_or("").to_string();
        let code = value["pairingCode"].as_str().unwrap_or("").to_string();
        if !verification_url(&url, &grant)
            || code.len() != 8
            || !code
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        {
            return Err("Неверные данные привязки устройства".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut s = self.state.lock().unwrap();
        if s.generation != generation {
            return Err("Вход отменён".into());
        }
        s.pending = Some(Pending {
            id: id.clone(),
            grant,
            verifier,
            deadline: Instant::now() + Duration::from_secs(300),
            next_poll: Instant::now() + Duration::from_secs(5),
            busy: false,
            remember,
        });
        Ok(Pairing {
            attempt_id: id,
            pairing_code: code,
            expires_in: 300,
            interval: 5,
            verification_url: url,
        })
    }
    pub async fn poll(&self, id: &str) -> Result<Value, String> {
        let (generation, grant, verifier) = {
            let mut s = self.state.lock().unwrap();
            let generation = s.generation;
            let p = s
                .pending
                .as_mut()
                .filter(|p| p.id == id)
                .ok_or("Вход отменён")?;
            if Instant::now() >= p.deadline {
                s.pending = None;
                return Err("Время входа истекло. Попробуйте ещё раз.".into());
            }
            if p.busy || Instant::now() < p.next_poll {
                return Ok(json!({"status":"pending"}));
            }
            p.busy = true;
            p.next_poll = Instant::now() + Duration::from_secs(5);
            (generation, p.grant.clone(), p.verifier.clone())
        };
        let result = self
            .request(
                "/api/desktop/exchange",
                Some(json!({"grant":grant,"verifier":verifier})),
                None,
            )
            .await;
        let mut s = self.state.lock().unwrap();
        if s.generation != generation || s.pending.as_ref().map(|p| p.id.as_str()) != Some(id) {
            self.revoke_late_exchange(&result);
            return Err("Вход отменён".into());
        }
        let p = s.pending.as_mut().unwrap();
        p.busy = false;
        let (status, value) = result?;
        if status == 428 || status == 429 {
            return Ok(json!({"status":"pending"}));
        }
        if status != 200 {
            s.pending = None;
            return Err(status_error(status));
        }
        let session = Session {
            issuer: ISSUER.into(),
            token: value["accessToken"].as_str().unwrap_or("").into(),
            expires_at: value["expiresAt"].as_u64().unwrap_or(0),
        };
        if value["tokenType"] != "Bearer" || !token_valid(&session) {
            s.pending = None;
            return Err("Неверный ответ авторизации".into());
        }
        let remember = p.remember;
        s.warning = None;
        if self.vault.clear().is_err() {
            s.warning = Some(warning());
        }
        if remember
            && self
                .vault
                .write(&serde_json::to_string(&session).map_err(|_| "Ошибка сохранения")?)
                .is_err()
        {
            s.warning = Some(warning());
        }
        s.generation += 1; // Reject /api/me responses for the previous session.
        s.session = Some(session);
        s.pending = None;
        Ok(json!({"status":"authenticated","warning":s.warning}))
    }
    // An exchange may have minted a server session just as the user cancelled.
    // Never install it; attempt revocation without blocking cancellation or logging credentials.
    fn revoke_late_exchange(&self, result: &Result<(u16, Value), String>) {
        let Ok((200, value)) = result else {
            return;
        };
        let session = Session {
            issuer: ISSUER.into(),
            token: value["accessToken"].as_str().unwrap_or("").into(),
            expires_at: value["expiresAt"].as_u64().unwrap_or(0),
        };
        if value["tokenType"] != "Bearer" || !token_valid(&session) {
            return;
        }
        #[cfg(test)]
        self.late_revocations
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        #[cfg(not(test))]
        {
            let client = self.client.clone();
            tokio::spawn(async move {
                let _ = client
                    .post(format!("{ISSUER}/api/auth/logout"))
                    .bearer_auth(session.token)
                    .json(&json!({}))
                    .send()
                    .await;
            });
        }
    }
    pub async fn status(&self) -> Result<Value, String> {
        let (generation, session, warning) = {
            let s = self.state.lock().unwrap();
            (s.generation, s.session.clone(), s.warning.clone())
        };
        let Some(session) = session else {
            return Ok(json!({"status":"signedOut","warning":warning}));
        };
        if !token_valid(&session) {
            if !self.cancel_session(generation) {
                return Err("Сессия изменилась".into());
            }
            return Ok(json!({"status":"expired"}));
        }
        let (status, value) = self.request("/api/me", None, Some(&session.token)).await?;
        if self.state.lock().unwrap().generation != generation {
            return Err("Сессия изменилась".into());
        }
        if status == 401 {
            if !self.cancel_session(generation) {
                return Err("Сессия изменилась".into());
            }
            return Ok(json!({"status":"expired"}));
        }
        if status != 200 {
            return Err(status_error(status));
        }
        if self.state.lock().unwrap().generation != generation {
            return Err("Сессия изменилась".into());
        }
        // Project explicitly; CSRF and provider credentials never cross IPC.
        Ok(
            json!({"status":"authenticated","profile":public_fields(&value["profile"], &["id", "username", "displayName", "bio", "avatar", "avatarUrl"]),"identities":value["identities"].as_array().map(|items| items.iter().filter(|v| v.as_str()==Some("google")||v.as_str()==Some("discord")).cloned().collect::<Vec<_>>()).unwrap_or_default(),"shikimori":if value["shikimori"].is_null(){Value::Null}else{public_fields(&value["shikimori"], &["id", "nickname"])},"warning":warning}),
        )
    }
    fn cancel_session(&self, generation: u64) -> bool {
        let mut s = self.state.lock().unwrap();
        if s.generation == generation {
            s.generation += 1;
            s.session = None;
            s.pending = None;
            if self.vault.clear().is_err() {
                s.warning = Some(warning());
            }
            true
        } else {
            false
        }
    }
    pub async fn logout(&self) -> Result<Value, String> {
        let (session, warning) = {
            let mut s = self.state.lock().unwrap();
            s.generation += 1;
            s.pending = None;
            let session = s.session.take();
            s.warning = if self.vault.clear().is_err() {
                Some(warning())
            } else {
                None
            };
            (session, s.warning.clone())
        };
        let mut revoked = true;
        if let Some(session) = session {
            revoked = matches!(
                self.request("/api/auth/logout", Some(json!({})), Some(&session.token))
                    .await,
                Ok((200..=299, _)) | Ok((401, _))
            );
        }
        Ok(json!({"status":"signedOut","warning":warning,"revoked":revoked}))
    }
}
fn public_fields(value: &Value, names: &[&str]) -> Value {
    let mut out = serde_json::Map::new();
    for name in names {
        let v = &value[*name];
        if v.is_string() || v.is_number() {
            out.insert((*name).into(), v.clone());
        }
    }
    Value::Object(out)
}
fn status_error(status: u16) -> String {
    match status {
        503 => "Сервис аккаунтов ещё не настроен. Анонимный просмотр доступен.",
        401 => "Сессия истекла. Войдите заново.",
        400 => "Привязка недействительна или истекла. Начните заново.",
        429 => "Слишком много запросов. Попробуйте позже.",
        _ => "Сервис аккаунтов временно недоступен.",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    struct MemoryVault {
        data: Arc<Mutex<Option<String>>>,
        fail: bool,
    }
    impl Vault for MemoryVault {
        fn read(&self) -> Result<Option<String>, ()> {
            if self.fail {
                Err(())
            } else {
                Ok(self.data.lock().unwrap().clone())
            }
        }
        fn write(&self, v: &str) -> Result<(), ()> {
            if self.fail {
                Err(())
            } else {
                *self.data.lock().unwrap() = Some(v.into());
                Ok(())
            }
        }
        fn clear(&self) -> Result<(), ()> {
            if self.fail {
                Err(())
            } else {
                *self.data.lock().unwrap() = None;
                Ok(())
            }
        }
    }
    fn account(fail: bool) -> (Account, Arc<Mutex<Option<String>>>) {
        let data = Arc::new(Mutex::new(None));
        (
            Account::with_vault(Box::new(MemoryVault {
                data: data.clone(),
                fail,
            }))
            .unwrap(),
            data,
        )
    }
    fn reply(a: &Account, status: u16, value: Value) {
        a.replies.lock().unwrap().push_back((status, value));
    }
    async fn start(a: &Account, remember: bool) -> Pairing {
        let grant = "A".repeat(43);
        reply(
            a,
            201,
            json!({"grant":grant,"verificationUrl":format!("{ISSUER}/desktop#grant={grant}"),"pairingCode":"ABCD1234"}),
        );
        a.start(remember).await.unwrap()
    }
    fn due(a: &Account) {
        a.state.lock().unwrap().pending.as_mut().unwrap().next_poll = Instant::now();
    }
    fn exchange(a: &Account) {
        reply(
            a,
            200,
            json!({"accessToken":"secret_bearer","tokenType":"Bearer","expiresAt":now()+3600}),
        );
    }
    #[test]
    fn exact_origin_and_path_only() {
        let g = "A".repeat(43);
        assert!(verification_url(&format!("{ISSUER}/desktop#grant={g}"), &g));
        for url in [
            format!("http://aniartix.pyanexy.cc/desktop#grant={g}"),
            format!("https://aniartix.pyanexy.cc.evil.test/desktop#grant={g}"),
            format!("https://user@aniartix.pyanexy.cc/desktop#grant={g}"),
            format!("{ISSUER}/other#grant={g}"),
        ] {
            assert!(!verification_url(&url, &g));
        }
    }
    #[test]
    fn pkce_is_random_and_s256() {
        let (v, c) = pkce();
        assert_eq!(c, URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes())));
        assert_eq!(c.len(), 43);
        assert!(v.len() >= 43 && v.len() <= 128);
        assert_ne!(v, pkce().0);
    }
    #[tokio::test]
    async fn startup_without_session() {
        let (a, _) = account(false);
        assert_eq!(a.status().await.unwrap()["status"], "signedOut");
    }
    #[tokio::test]
    async fn pending_throttle_and_cancel() {
        let (a, _) = account(false);
        let p = start(&a, false).await;
        assert_eq!(a.poll(&p.attempt_id).await.unwrap()["status"], "pending");
        due(&a);
        reply(&a, 428, json!({}));
        assert_eq!(a.poll(&p.attempt_id).await.unwrap()["status"], "pending");
        a.cancel();
        assert!(a.poll(&p.attempt_id).await.is_err());
        assert!(a.state.lock().unwrap().session.is_none());
    }
    #[tokio::test]
    async fn old_attempt_cannot_poll_new_grant() {
        let (a, _) = account(false);
        let old = start(&a, false).await;
        let current = start(&a, false).await;
        assert!(a.poll(&old.attempt_id).await.is_err());
        assert_eq!(
            a.state.lock().unwrap().pending.as_ref().unwrap().id,
            current.attempt_id
        );
    }
    #[tokio::test]
    async fn single_flight_and_deadline() {
        let (a, _) = account(false);
        let p = start(&a, false).await;
        due(&a);
        a.state.lock().unwrap().pending.as_mut().unwrap().busy = true;
        assert_eq!(a.poll(&p.attempt_id).await.unwrap()["status"], "pending");
        a.state.lock().unwrap().pending.as_mut().unwrap().deadline = Instant::now();
        assert!(a.poll(&p.attempt_id).await.is_err());
        assert!(a.state.lock().unwrap().pending.is_none());
    }
    #[tokio::test]
    async fn token_stays_native_and_remember_is_optional() {
        let (a, data) = account(false);
        let p = start(&a, false).await;
        assert!(!serde_json::to_string(&p).unwrap().contains("verification"));
        due(&a);
        exchange(&a);
        let result = a.poll(&p.attempt_id).await.unwrap();
        assert!(!result.to_string().contains("secret_bearer"));
        assert!(data.lock().unwrap().is_none());
        assert_eq!(
            a.state.lock().unwrap().session.as_ref().unwrap().token,
            "secret_bearer"
        );
    }
    #[tokio::test]
    async fn vault_failure_keeps_memory_session() {
        let (a, _) = account(true);
        let p = start(&a, true).await;
        due(&a);
        exchange(&a);
        let result = a.poll(&p.attempt_id).await.unwrap();
        assert_eq!(result["status"], "authenticated");
        assert!(result["warning"].is_string());
        assert!(a.state.lock().unwrap().session.is_some());
    }
    #[tokio::test]
    async fn remembered_session_and_logout() {
        let (a, data) = account(false);
        let p = start(&a, true).await;
        due(&a);
        exchange(&a);
        a.poll(&p.attempt_id).await.unwrap();
        assert!(data.lock().unwrap().is_some());
        reply(&a, 200, json!({}));
        assert_eq!(a.logout().await.unwrap()["revoked"], true);
        assert!(data.lock().unwrap().is_none());
        assert!(a.state.lock().unwrap().session.is_none());
    }
    #[tokio::test]
    async fn logout_clears_even_when_offline() {
        let (a, _) = account(false);
        let p = start(&a, false).await;
        due(&a);
        exchange(&a);
        a.poll(&p.attempt_id).await.unwrap();
        assert_eq!(a.logout().await.unwrap()["revoked"], false);
        assert_eq!(a.status().await.unwrap()["status"], "signedOut");
    }
    #[tokio::test]
    async fn rejected_bearer_is_cleared() {
        let (a, data) = account(false);
        let p = start(&a, true).await;
        due(&a);
        exchange(&a);
        a.poll(&p.attempt_id).await.unwrap();
        reply(&a, 401, json!({}));
        assert_eq!(a.status().await.unwrap()["status"], "expired");
        assert!(data.lock().unwrap().is_none());
    }
    #[test]
    fn wrong_issuer_and_expired_saved_sessions_are_rejected() {
        for issuer in ["https://evil.test", ISSUER] {
            let data = Arc::new(Mutex::new(Some(
                serde_json::to_string(&Session {
                    issuer: issuer.into(),
                    token: "secret".into(),
                    expires_at: if issuer == ISSUER { 0 } else { now() + 1000 },
                })
                .unwrap(),
            )));
            let a = Account::with_vault(Box::new(MemoryVault {
                data: data.clone(),
                fail: false,
            }))
            .unwrap();
            assert!(a.state.lock().unwrap().session.is_none());
            assert!(data.lock().unwrap().is_none());
        }
    }
    #[tokio::test]
    async fn missing_backend_is_not_fake_login() {
        let (a, _) = account(false);
        reply(&a, 503, json!({}));
        assert!(a.start(false).await.err().unwrap().contains("не настроен"));
        assert!(a.state.lock().unwrap().session.is_none());
    }
    #[tokio::test]
    async fn cancelling_inflight_exchange_never_installs_session() {
        let (a, data) = account(false);
        let a = Arc::new(a);
        let p = start(&a, true).await;
        due(&a);
        exchange(&a);
        let gate = Arc::new(tokio::sync::Notify::new());
        *a.gate.lock().unwrap() = Some(gate.clone());
        let task = {
            let a = a.clone();
            tokio::spawn(async move { a.poll(&p.attempt_id).await })
        };
        tokio::task::yield_now().await;
        a.cancel();
        gate.notify_one();
        assert!(task.await.unwrap().is_err());
        assert_eq!(
            a.late_revocations.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert!(a.state.lock().unwrap().session.is_none());
        assert!(data.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn cancelling_inflight_start_never_opens_pairing() {
        let (a, _) = account(false);
        let a = Arc::new(a);
        let grant = "A".repeat(43);
        reply(
            &a,
            201,
            json!({"grant":grant,"verificationUrl":format!("{ISSUER}/desktop#grant={grant}"),"pairingCode":"ABCD1234"}),
        );
        let gate = Arc::new(tokio::sync::Notify::new());
        *a.gate.lock().unwrap() = Some(gate.clone());
        let task = {
            let a = a.clone();
            tokio::spawn(async move { a.start(false).await })
        };
        tokio::task::yield_now().await;
        a.cancel();
        gate.notify_one();
        assert!(task.await.unwrap().is_err());
        assert!(a.state.lock().unwrap().pending.is_none());
    }
    #[tokio::test]
    async fn profile_projection_omits_server_secrets() {
        let (a, _) = account(false);
        let p = start(&a, false).await;
        due(&a);
        exchange(&a);
        a.poll(&p.attempt_id).await.unwrap();
        reply(
            &a,
            200,
            json!({"csrfToken":"csrf_secret","accessToken":"secret_bearer","profile":{"id":"id","username":"user","avatarUrl":"/api/avatars/id?v=123","token":"secret_bearer"},"shikimori":{"id":123,"nickname":"name","accessToken":"provider_secret"},"identities":["google","unknown"]}),
        );
        let v = a.status().await.unwrap();
        let text = v.to_string();
        assert!(!text.contains("secret"));
        assert_eq!(v["profile"]["username"], "user");
        assert_eq!(v["profile"]["avatarUrl"], "/api/avatars/id?v=123");
        assert_eq!(v["identities"], json!(["google"]));
    }
    #[tokio::test]
    async fn valid_saved_session_is_restored_without_network() {
        let data = Arc::new(Mutex::new(Some(
            serde_json::to_string(&Session {
                issuer: ISSUER.into(),
                token: "saved_token".into(),
                expires_at: now() + 3600,
            })
            .unwrap(),
        )));
        let a = Account::with_vault(Box::new(MemoryVault { data, fail: false })).unwrap();
        assert_eq!(
            a.state.lock().unwrap().session.as_ref().unwrap().token,
            "saved_token"
        );
        assert!(a.replies.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn nonremembered_login_removes_old_vault_session() {
        let (a, data) = account(false);
        *data.lock().unwrap() = Some("old_token".into());
        let p = start(&a, false).await;
        due(&a);
        exchange(&a);
        a.poll(&p.attempt_id).await.unwrap();
        assert!(data.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn logout_vault_failure_is_disclosed() {
        let (a, _) = account(true);
        let p = start(&a, true).await;
        due(&a);
        exchange(&a);
        a.poll(&p.attempt_id).await.unwrap();
        reply(&a, 200, json!({}));
        let value = a.logout().await.unwrap();
        assert_eq!(value["status"], "signedOut");
        assert!(value["warning"].is_string());
        assert!(a.state.lock().unwrap().session.is_none());
    }
    #[tokio::test]
    async fn backend_base64url_pairing_code_is_accepted() {
        let (a, _) = account(false);
        let grant = "A".repeat(43);
        reply(
            &a,
            201,
            json!({"grant":grant,"verificationUrl":format!("{ISSUER}/desktop#grant={grant}"),"pairingCode":"AB-_1234"}),
        );
        assert_eq!(a.start(false).await.unwrap().pairing_code, "AB-_1234");
    }
    #[tokio::test]
    async fn old_profile_401_cannot_expire_new_generation() {
        let (a, _) = account(false);
        let a = Arc::new(a);
        let p = start(&a, false).await;
        due(&a);
        exchange(&a);
        a.poll(&p.attempt_id).await.unwrap();
        reply(&a, 401, json!({}));
        let gate = Arc::new(tokio::sync::Notify::new());
        *a.gate.lock().unwrap() = Some(gate.clone());
        let task = {
            let a = a.clone();
            tokio::spawn(async move { a.status().await })
        };
        tokio::task::yield_now().await;
        a.state.lock().unwrap().generation += 1;
        gate.notify_one();
        assert!(task.await.unwrap().is_err());
        assert!(a.state.lock().unwrap().session.is_some());
    }
    async fn signed_in() -> Account {
        let (a, _) = account(false);
        let p = start(&a, false).await;
        due(&a);
        exchange(&a);
        a.poll(&p.attempt_id).await.unwrap();
        a
    }
    #[tokio::test]
    async fn social_requires_own_session() {
        let (a, _) = account(false);
        assert!(a.friends_list().await.is_err());
        assert!(a.watch_invites_list().await.is_err());
    }
    #[tokio::test]
    async fn social_projection_strips_nested_credentials_and_capabilities() {
        let a = signed_in().await;
        let profile = json!({"id":"id","username":"user","accessToken":"secret"});
        reply(
            &a,
            200,
            json!({"friends":[profile],"incoming":[{"id":"request","createdAt":1,"profile":profile,"hostToken":"secret"}],"outgoing":[],"csrfToken":"secret"}),
        );
        assert!(!serde_json::to_string(&a.friends_list().await.unwrap())
            .unwrap()
            .contains("secret"));
        reply(
            &a,
            200,
            json!({"invites":[{"id":"invite","sender":profile,"createdAt":1,"expiresAt":2,"inviteToken":"secret","roomId":"secret"}]}),
        );
        assert!(
            !serde_json::to_string(&a.watch_invites_list().await.unwrap())
                .unwrap()
                .contains("secret")
        );
    }
    #[tokio::test]
    async fn social_rejects_path_injection_before_transport() {
        let a = signed_in().await;
        for id in ["../auth/logout", "id?token=secret", "https://evil.test", ""] {
            assert!(a.friends_request(id).await.is_err());
            assert!(a.friends_remove(id).await.is_err());
            assert!(a.friends_accept(id).await.is_err());
            assert!(a.watch_invite_accept(id).await.is_err());
        }
        for name in ["ab", "user&other=1", "user/name", "a-b"] {
            assert!(a.friends_lookup(name).await.is_err());
        }
        assert!(a
            .watch_invite_send("user", "bad-room", "token")
            .await
            .is_err());
    }
    #[tokio::test]
    async fn accepted_invite_has_fixed_relay_and_valid_capability() {
        let a = signed_in().await;
        for server in [
            "wss://evil.test/watch",
            "ws://aniartix.pyanexy.cc/watch",
            "wss://aniartix.pyanexy.cc/watch?token=secret",
        ] {
            reply(
                &a,
                200,
                json!({"serverUrl":server,"roomId":"a".repeat(12),"inviteToken":"b".repeat(48)}),
            );
            assert!(a.watch_invite_accept(&"A".repeat(43)).await.is_err());
        }
        reply(
            &a,
            200,
            json!({"serverUrl":"wss://aniartix.pyanexy.cc/watch","roomId":"a".repeat(12),"inviteToken":"b".repeat(48),"accessToken":"secret"}),
        );
        let v =
            serde_json::to_value(a.watch_invite_accept(&"A".repeat(43)).await.unwrap()).unwrap();
        assert_eq!(v["inviteToken"], "b".repeat(48));
        assert!(!v.to_string().contains("secret"));
    }
    #[tokio::test]
    async fn social_401_expires_only_current_session() {
        let a = signed_in().await;
        reply(&a, 401, json!({"error":"secret"}));
        assert!(a.friends_list().await.is_err());
        assert!(a.state.lock().unwrap().session.is_none());
    }
    #[tokio::test]
    async fn stale_social_response_cannot_leak_or_expire_new_session() {
        for status in [200, 401] {
            let a = Arc::new(signed_in().await);
            reply(
                &a,
                status,
                json!({"friends":[],"incoming":[],"outgoing":[]}),
            );
            let gate = Arc::new(tokio::sync::Notify::new());
            *a.gate.lock().unwrap() = Some(gate.clone());
            let task = {
                let a = a.clone();
                tokio::spawn(async move { a.friends_list().await })
            };
            tokio::task::yield_now().await;
            a.state.lock().unwrap().generation += 1;
            gate.notify_one();
            assert!(task.await.unwrap().is_err());
            assert!(a.state.lock().unwrap().session.is_some());
        }
    }
    #[tokio::test]
    async fn social_routes_use_expected_verbs_and_native_auth() {
        let a = signed_in().await;
        a.requests.lock().unwrap().clear();
        reply(&a, 200, json!({"ok":true}));
        a.friends_remove("user").await.unwrap();
        reply(&a, 200, json!({"profile":{"id":"user","username":"alice"}}));
        a.friends_lookup("alice").await.unwrap();
        reply(&a, 201, json!({"id":"request"}));
        a.friends_request("user").await.unwrap();
        reply(&a, 201, json!({"id":"invite","expiresAt":123}));
        a.watch_invite_send("user", &"a".repeat(12), &"b".repeat(48))
            .await
            .unwrap();
        let calls = a.requests.lock().unwrap();
        assert_eq!(
            calls[0],
            ("DELETE".into(), "/api/friends/user".into(), None, true)
        );
        assert_eq!(
            calls[1],
            (
                "GET".into(),
                "/api/friends/lookup?username=alice".into(),
                None,
                true
            )
        );
        assert_eq!(
            calls[2],
            (
                "POST".into(),
                "/api/friends/requests".into(),
                Some(json!({"userId":"user"})),
                true
            )
        );
        assert_eq!(calls[3].0, "POST");
        assert_eq!(calls[3].1, "/api/watch-invites");
        assert!(calls[3].3);
    }
}
