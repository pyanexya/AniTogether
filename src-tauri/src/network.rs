use futures_util::StreamExt;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use url::Url;
const MAX_BODY: usize = 16 * 1024 * 1024;
static REQUEST_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_unspecified()
                && !v.is_multicast()
                && !v.is_broadcast()
                && v.octets()[0] != 0
                && v.octets()[0] < 224
                && !(v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1]))
                && !(v.octets()[0] == 192 && v.octets()[1] == 0 && matches!(v.octets()[2], 0 | 2))
                && !(v.octets()[0] == 198 && matches!(v.octets()[1], 18 | 19))
                && v.octets()[..3] != [198, 51, 100]
                && v.octets()[..3] != [203, 0, 113]
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                public_ip(IpAddr::V4(v4))
            } else {
                (v.segments()[0] & 0xe000) == 0x2000
                    && v.segments()[..2] != [0x2001, 0x0db8]
                    && !(v.segments()[0] == 0x2001 && v.segments()[1] < 0x0200)
            }
        }
    }
}
pub fn validate_url(value: &str) -> Result<Url, String> {
    if value.len() > 16384 {
        return Err("URL too long".into());
    }
    let url = Url::parse(value).map_err(|_| "Invalid URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTP(S) URLs without credentials are supported".into());
    }
    let host = url
        .host_str()
        .ok_or("Missing host")?
        .trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || !host.contains('.') && !host.contains(':')
    {
        return Err("Local network requests are blocked".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !public_ip(ip) {
            return Err("Local network requests are blocked".into());
        }
    }
    Ok(url)
}
struct PublicDns;
impl reqwest::dns::Resolve for PublicDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let addresses: Vec<SocketAddr> =
                tokio::net::lookup_host((name.as_str(), 0)).await?.collect();
            if addresses.is_empty() || addresses.iter().any(|s| !public_ip(s.ip())) {
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "Local address blocked",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}
pub fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .dns_resolver(Arc::new(PublicDns))
        .timeout(Duration::from_secs(45))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("Too many redirects")
            } else if validate_url(attempt.url().as_str()).is_err() {
                attempt.error("Unsafe redirect")
            } else if attempt
                .previous()
                .last()
                .is_some_and(|u| u.scheme() == "https")
                && attempt.url().scheme() != "https"
            {
                attempt.error("HTTPS downgrade blocked")
            } else {
                attempt.follow()
            }
        }))
        .user_agent("AnixArtix/0.1.0 (Windows; Desktop)")
}
pub fn client() -> Result<Client, String> {
    client_builder()
        .build()
        .map_err(|_| "HTTP client setup failed".into())
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestInfo {
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    pub body_bytes: Option<Vec<u8>>,
    pub redirect: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResponse {
    pub ok: bool,
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub text: String,
}
pub async fn bounded_bytes(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("Response exceeds size limit".into());
    }
    let mut stream = response.bytes_stream();
    let mut data = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Response read failed")?;
        if data.len() + chunk.len() > limit {
            return Err("Response exceeds size limit".into());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn net_fetch(
    url: String,
    request_info: Option<RequestInfo>,
) -> Result<FetchResponse, String> {
    let _permit = REQUEST_SLOTS
        .acquire()
        .await
        .map_err(|_| "HTTP request queue closed")?;
    let url = validate_url(&url)?;
    let info = request_info.unwrap_or_default();
    let method = Method::from_bytes(info.method.as_deref().unwrap_or("GET").as_bytes())
        .map_err(|_| "Invalid method")?;
    if !matches!(
        method,
        Method::GET
            | Method::HEAD
            | Method::POST
            | Method::PUT
            | Method::PATCH
            | Method::DELETE
            | Method::OPTIONS
    ) {
        return Err("Unsupported method".into());
    }
    let mut builder = client_builder();
    if info.redirect.as_deref() == Some("error") || info.redirect.as_deref() == Some("manual") {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }
    let mut req = builder
        .build()
        .map_err(|_| "HTTP client setup failed")?
        .request(method, url);
    if let Some(headers) = info.headers {
        if headers.len() > 64 {
            return Err("Too many headers".into());
        }
        for (k, v) in headers {
            if v.len() > 16384 {
                return Err("Header too long".into());
            }
            if [
                "host",
                "connection",
                "content-length",
                "proxy-authorization",
                "proxy-connection",
                "transfer-encoding",
            ]
            .contains(&k.to_ascii_lowercase().as_str())
            {
                continue;
            }
            req = req.header(k, v);
        }
    }
    if let Some(body) = info.body {
        if body.len() > MAX_BODY {
            return Err("Request too large".into());
        }
        req = req.body(body);
    }
    if let Some(bytes) = info.body_bytes {
        if bytes.len() > MAX_BODY {
            return Err("Request too large".into());
        }
        req = req.body(bytes);
    }
    let response = req
        .send()
        .await
        .map_err(|_| "HTTP request failed (network, timeout or unsafe destination)")?;
    if info.redirect.as_deref() == Some("error") && response.status().is_redirection() {
        return Err("Redirect rejected".into());
    }
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
        .collect();
    let data = bounded_bytes(response, MAX_BODY).await?;
    Ok(FetchResponse {
        ok: status.is_success(),
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").into(),
        headers,
        text: String::from_utf8_lossy(&data).into_owned(),
    })
}
pub fn oauth_url(domain: &str) -> Result<String, String> {
    if ["shikimori.io", "shikimori.me", "shikimori.one"].contains(&domain) {
        Ok(format!("https://{domain}/oauth/token"))
    } else {
        Err("Unsupported Shikimori domain".into())
    }
}
async fn oauth(
    value: String,
    domain: Option<String>,
    client_id: Option<String>,
    refresh: bool,
) -> Result<Value, String> {
    if value.trim().is_empty() || value.len() > 16384 {
        return Err("Invalid OAuth token/code".into());
    }
    let endpoint = oauth_url(domain.as_deref().unwrap_or("shikimori.io"))?;
    let id = client_id
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("SHIKIMORI_CLIENT_ID").ok())
        .ok_or("Shikimori client ID is not configured")?;
    let secret = std::env::var("SHIKIMORI_CLIENT_SECRET").map_err(|_| {
        "Shikimori OAuth не настроен: требуется SHIKIMORI_CLIENT_SECRET в окружении приложения"
    })?;
    let client = Client::builder()
        .no_proxy()
        .dns_resolver(Arc::new(PublicDns))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "OAuth client failed")?;
    let mut form = HashMap::from([
        (
            "grant_type",
            if refresh {
                "refresh_token"
            } else {
                "authorization_code"
            },
        ),
        ("client_id", id.as_str()),
        ("client_secret", secret.as_str()),
        (if refresh { "refresh_token" } else { "code" }, value.trim()),
    ]);
    if !refresh {
        form.insert("redirect_uri", "urn:ietf:wg:oauth:2.0:oob");
    }
    let response = client
        .post(endpoint)
        .header("User-Agent", "AnixArtix/0.1.0")
        .form(&form)
        .send()
        .await
        .map_err(|_| "OAuth network request failed")?;
    if !response.status().is_success() {
        return Err(format!(
            "Shikimori OAuth HTTP {}",
            response.status().as_u16()
        ));
    }
    serde_json::from_slice(&bounded_bytes(response, 262144).await?)
        .map_err(|_| "Invalid OAuth response".into())
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn oauth_exchange(
    auth_code: String,
    domain: Option<String>,
    client_id: Option<String>,
) -> Result<Value, String> {
    oauth(auth_code, domain, client_id, false).await
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn oauth_refresh(
    refresh_token: String,
    domain: Option<String>,
    client_id: Option<String>,
) -> Result<Value, String> {
    oauth(refresh_token, domain, client_id, true).await
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn sibnet_parse(link: String) -> Result<String, String> {
    let url = validate_url(&link)?;
    if url.host_str() != Some("video.sibnet.ru") {
        return Err("Expected a video.sibnet.ru link".into());
    }
    let response = net_fetch(link.clone(), None).await?;
    if !response.ok {
        return Err("Sibnet page unavailable".into());
    }
    let pattern = regex::Regex::new(r#"src:\s*["']([^"']+)["']"#).map_err(|e| e.to_string())?;
    let source = pattern
        .captures(&response.text)
        .and_then(|c| c.get(1))
        .ok_or("Sibnet video URL not found")?
        .as_str();
    let source = url.join(source).map_err(|_| "Invalid Sibnet video URL")?;
    validate_url(source.as_str())?;
    Ok(source.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_unsafe_destinations() {
        for u in [
            "file:///etc/passwd",
            "http://localhost/x",
            "http://127.0.0.1",
            "http://192.168.1.1",
            "http://169.254.169.254",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "https://user:pass@example.com",
            "http://100.64.0.1",
            "http://198.18.0.1",
            "http://[::127.0.0.1]/",
        ] {
            assert!(validate_url(u).is_err(), "{u}");
        }
    }
    #[tokio::test]
    async fn resolver_rejects_localhost_addresses() {
        use reqwest::dns::Resolve;
        let name = "localhost".parse().unwrap();
        assert!(PublicDns.resolve(name).await.is_err());
    }
    #[test]
    fn allows_public_http() {
        assert!(validate_url("https://api.anixart.tv/profile").is_ok());
        assert!(validate_url("https://8.8.8.8/").is_ok());
    }
    #[test]
    fn oauth_domain_is_exact() {
        assert!(oauth_url("shikimori.io").is_ok());
        for d in [
            "shikimori.io.evil.test",
            "https://shikimori.io",
            "SHIKIMORI.IO",
            "evil.test",
        ] {
            assert!(oauth_url(d).is_err());
        }
    }
}
