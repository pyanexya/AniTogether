//! Capability-addressed, loopback-only streaming transport. No video crosses room peers.
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, OnceCell, Semaphore},
};
use url::Url;
const MAX_RESOURCES: usize = 16384;
const MAX_PLAYLIST: usize = 2 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(12 * 3600);
static SERVICE: OnceCell<Arc<Proxy>> = OnceCell::const_new();
#[derive(Clone)]
struct Resource {
    offline: Option<std::path::PathBuf>,
    url: Url,
    referer: Option<String>,
    group: String,
    expires: Instant,
}
struct Proxy {
    base: String,
    entries: Mutex<HashMap<String, Resource>>,
    client: reqwest::Client,
    slots: Arc<Semaphore>,
}
impl Proxy {
    async fn start(client: reqwest::Client) -> Result<Arc<Self>, String> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "Cannot start local media transport")?;
        let p = Arc::new(Self {
            base: format!(
                "http://127.0.0.1:{}",
                listener
                    .local_addr()
                    .map_err(|_| "Local transport unavailable")?
                    .port()
            ),
            entries: Mutex::new(HashMap::new()),
            client,
            slots: Arc::new(Semaphore::new(24)),
        });
        let service = p.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let Ok(permit) = service.slots.clone().try_acquire_owned() else {
                    let _ = socket.shutdown().await;
                    continue;
                };
                let p = service.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = p.serve(&mut socket).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Ok(p)
    }
    fn validate(&self, url: &str) -> Result<Url, String> {
        crate::network::validate_url(url)
    }
    async fn insert(
        &self,
        url: Url,
        referer: Option<String>,
        group: Option<String>,
    ) -> Result<String, String> {
        let mut map = self.entries.lock().await;
        map.retain(|_, v| v.expires > Instant::now());
        let expires = if let Some(ref g) = group {
            map.get(g).ok_or("Media session closed or expired")?.expires
        } else {
            Instant::now() + TTL
        };
        if let Some(ref g) = group {
            if let Some((token, _)) = map.iter().find(|(_, r)| r.group == *g && r.url == url) {
                return Ok(format!("{}/{}", self.base, token));
            }
        }
        if map.len() >= MAX_RESOURCES {
            return Err("Media resource limit reached; reopen playback".into());
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        let group = group.unwrap_or_else(|| token.clone());
        map.insert(
            token.clone(),
            Resource {
                offline: None,
                url,
                referer,
                group,
                expires,
            },
        );
        Ok(format!("{}/{}", self.base, token))
    }
    async fn rewrite(&self, text: &str, base: &Url, r: &Resource) -> Result<String, String> {
        if !text
            .trim_start_matches('\u{feff}')
            .trim_start()
            .starts_with("#EXTM3U")
        {
            return Err("Invalid HLS playlist".into());
        }
        let re = regex::Regex::new(r#"URI="([^"]*)""#).unwrap();
        let mut output = String::new();
        let mut variant = false;
        for line in text.trim_start_matches('\u{feff}').lines() {
            let line = line.trim();
            if !line.is_empty() && !line.starts_with('#') {
                let u = base.join(line).map_err(|_| "Invalid playlist URL")?;
                self.validate(u.as_str())?;
                output.push_str(
                    &self
                        .insert(u, r.referer.clone(), Some(r.group.clone()))
                        .await?,
                );
                if variant {
                    output.push_str("/stream.m3u8");
                }
                variant = false;
            } else {
                let mut end = 0;
                for cap in re.captures_iter(line) {
                    let m = cap.get(1).unwrap();
                    output.push_str(&line[end..m.start()]);
                    let u = base.join(m.as_str()).map_err(|_| "Invalid playlist URI")?;
                    self.validate(u.as_str())?;
                    output.push_str(
                        &self
                            .insert(u, r.referer.clone(), Some(r.group.clone()))
                            .await?,
                    );
                    if [
                        "#EXT-X-MEDIA:",
                        "#EXT-X-I-FRAME-STREAM-INF:",
                        "#EXT-X-RENDITION-REPORT:",
                    ]
                    .iter()
                    .any(|tag| line.starts_with(tag))
                    {
                        output.push_str("/stream.m3u8");
                    }
                    end = m.end();
                }
                output.push_str(&line[end..]);
                if line.starts_with("#EXT-X-STREAM-INF:") {
                    variant = true;
                }
            }
            output.push('\n');
            if output.len() > MAX_PLAYLIST * 4 {
                return Err("Rewritten playlist too large".into());
            }
        }
        Ok(output)
    }
    async fn serve(&self, socket: &mut TcpStream) -> Result<(), String> {
        let mut raw = Vec::new();
        loop {
            let mut b = [0u8; 1024];
            let n = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut b))
                .await
                .map_err(|_| "Request timed out")?
                .map_err(|_| "Read failed")?;
            if n == 0 {
                return Ok(());
            }
            raw.extend_from_slice(&b[..n]);
            if raw.len() > 16384 {
                return reply(socket, 431, "", &[]).await;
            }
            if raw.windows(4).any(|s| s == b"\r\n\r\n") {
                break;
            }
        }
        let request = std::str::from_utf8(&raw).map_err(|_| "Invalid request")?;
        let mut lines = request.split("\r\n");
        let first = lines
            .next()
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>();
        if first.len() != 3 {
            return reply(socket, 400, "", &[]).await;
        }
        let method = first[0];
        if !matches!(method, "GET" | "HEAD" | "OPTIONS") {
            return reply(socket, 405, "", &[]).await;
        }
        let mut origin = None;
        let mut range = None;
        let mut if_range = None;
        let mut host = None;
        for line in lines.take_while(|l| !l.is_empty()) {
            let Some((k, v)) = line.split_once(':') else {
                return reply(socket, 400, "", &[]).await;
            };
            match k.to_ascii_lowercase().as_str() {
                "origin" => origin = Some(v.trim()),
                "range" => range = Some(v.trim()),
                "if-range" => if_range = Some(v.trim()),
                "host" => host = Some(v.trim()),
                _ => {}
            }
        }
        if host != self.base.strip_prefix("http://") {
            return reply(socket, 403, "", &[]).await;
        }
        let mut headers = vec![
            (
                "Content-Security-Policy".into(),
                "default-src 'none'; sandbox; frame-ancestors 'none'".into(),
            ),
            ("Cache-Control".into(), "no-store".into()),
            ("X-Content-Type-Options".into(), "nosniff".into()),
        ];
        if let Some(o) = origin {
            if ![
                "tauri://localhost",
                "http://tauri.localhost",
                "https://tauri.localhost",
                "http://localhost:8080",
            ]
            .contains(&o)
            {
                return reply(socket, 403, "", &[]).await;
            }
            headers.push(("Access-Control-Allow-Origin".into(), o.into()));
            headers.push(("Vary".into(), "Origin".into()));
            headers.push((
                "Access-Control-Expose-Headers".into(),
                "Content-Length, Content-Range, Accept-Ranges".into(),
            ));
        }
        let token = first[1].strip_prefix('/').unwrap_or("");
        let token = token.strip_suffix("/stream.m3u8").unwrap_or(token);
        let resource = self
            .entries
            .lock()
            .await
            .get(token)
            .filter(|r| r.expires > Instant::now())
            .cloned();
        let Some(r) = resource else {
            return reply(socket, 404, "", &headers).await;
        };
        if method == "OPTIONS" {
            headers.push((
                "Access-Control-Allow-Methods".into(),
                "GET, HEAD, OPTIONS".into(),
            ));
            headers.push((
                "Access-Control-Allow-Headers".into(),
                "Range, If-Range".into(),
            ));
            return reply(socket, 204, "", &headers).await;
        }
        if let Some(path) = &r.offline {
            return crate::offline_stream::serve(socket, path, method, range, &headers).await;
        }
        let mut req = self
            .client
            .request(
                if method == "HEAD" {
                    reqwest::Method::HEAD
                } else {
                    reqwest::Method::GET
                },
                r.url.clone(),
            )
            .header("Accept-Encoding", "identity");
        if let Some(v) = range {
            if v.len() > 128
                || !regex::Regex::new(r"^bytes=\d*-\d*$").unwrap().is_match(v)
                || v == "bytes=-"
            {
                return reply(socket, 400, "", &headers).await;
            }
            req = req.header("Range", v);
        }
        if let Some(v) = if_range {
            req = req.header("If-Range", v);
        }
        if let Some(v) = &r.referer {
            req = req.header("Referer", v);
        }
        let response = match req.send().await {
            Ok(r) => r,
            Err(_) => return reply(socket, 502, "", &headers).await,
        };
        let status = response.status().as_u16();
        let playlist = first[1].ends_with("/stream.m3u8")
            || response
                .url()
                .path()
                .to_ascii_lowercase()
                .ends_with(".m3u8")
            || response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| {
                    let v = v.to_ascii_lowercase();
                    v.contains("mpegurl") || v.contains("vnd.apple")
                });
        if playlist && status == 200 && method != "HEAD" {
            let base = response.url().clone();
            let data = crate::network::bounded_bytes(response, MAX_PLAYLIST).await?;
            let text = std::str::from_utf8(&data).map_err(|_| "Invalid playlist encoding")?;
            let rewritten = self.rewrite(text, &base, &r).await?;
            headers.push((
                "Content-Type".into(),
                "application/vnd.apple.mpegurl".into(),
            ));
            return reply(socket, 200, &rewritten, &headers).await;
        }
        for k in [
            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
            "etag",
            "last-modified",
        ] {
            if let Some(v) = response.headers().get(k).and_then(|v| v.to_str().ok()) {
                headers.push((k.into(), v.into()));
            }
        }
        if !headers.iter().any(|(k, _)| k == "content-type") {
            headers.push(("Content-Type".into(), "application/octet-stream".into()));
        }
        let chunked = !headers.iter().any(|(k, _)| k == "content-length") && method != "HEAD";
        if chunked {
            headers.push(("Transfer-Encoding".into(), "chunked".into()));
        }
        write_head(socket, status, &headers).await?;
        if method == "HEAD" {
            return Ok(());
        }
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "Upstream interrupted")?;
            if chunk.is_empty() {
                continue;
            }
            if chunked {
                write(socket, format!("{:x}\r\n", chunk.len()).as_bytes()).await?;
            }
            write(socket, &chunk).await?;
            if chunked {
                write(socket, b"\r\n").await?;
            }
        }
        if chunked {
            write(socket, b"0\r\n\r\n").await?;
        }
        Ok(())
    }
}
async fn write(s: &mut TcpStream, b: &[u8]) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(30), s.write_all(b))
        .await
        .map_err(|_| "Client stalled")?
        .map_err(|_| "Client disconnected".into())
}
async fn write_head(
    s: &mut TcpStream,
    status: u16,
    headers: &[(String, String)],
) -> Result<(), String> {
    let mut h = format!(
        "HTTP/1.1 {status} {}\r\nConnection: close\r\n",
        reqwest::StatusCode::from_u16(status)
            .ok()
            .and_then(|s| s.canonical_reason())
            .unwrap_or("Response")
    );
    for (k, v) in headers {
        h.push_str(&format!("{k}: {v}\r\n"));
    }
    h.push_str("\r\n");
    write(s, h.as_bytes()).await
}
async fn reply(
    s: &mut TcpStream,
    status: u16,
    body: &str,
    headers: &[(String, String)],
) -> Result<(), String> {
    let mut h = headers.to_vec();
    h.push(("Content-Length".into(), body.len().to_string()));
    write_head(s, status, &h).await?;
    write(s, body.as_bytes()).await
}
async fn service() -> Result<&'static Arc<Proxy>, String> {
    SERVICE
        .get_or_try_init(|| async {
            let client = crate::network::client_builder()
                .timeout(Duration::from_secs(24 * 3600))
                .read_timeout(Duration::from_secs(60))
                .no_gzip()
                .no_brotli()
                .build()
                .map_err(|_| "Media client unavailable")?;
            Proxy::start(client).await
        })
        .await
}
/// Called only after Downloads has resolved a registered completed media item.
pub(crate) async fn register_owned_file(path: std::path::PathBuf) -> Result<String, String> {
    let p = service().await?;
    let local = p
        .insert(Url::parse("https://offline.invalid/").unwrap(), None, None)
        .await?;
    let token = local
        .strip_prefix(&format!("{}/", p.base))
        .ok_or("Invalid local handle")?;
    p.entries
        .lock()
        .await
        .get_mut(token)
        .ok_or("Media session expired")?
        .offline = Some(path);
    Ok(local)
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn media_open(url: String, referer: Option<String>) -> Result<String, String> {
    let url = crate::network::validate_url(&url)?;
    if let Some(ref r) = referer {
        crate::network::validate_url(r)?;
    }
    let p = service().await?;
    let mut hls = url.path().to_ascii_lowercase().ends_with(".m3u8");
    if !hls && !url.path().to_ascii_lowercase().ends_with(".mp4") {
        // Header-only classification, with at most one small chunk inspected if a
        // provider labels an extensionless playlist application/octet-stream.
        let mut req = p
            .client
            .get(url.clone())
            .timeout(Duration::from_secs(15))
            .header("Range", "bytes=0-1023")
            .header("Accept-Encoding", "identity");
        if let Some(ref r) = referer {
            req = req.header("Referer", r);
        }
        if let Ok(mut response) = req.send().await {
            hls = response
                .url()
                .path()
                .to_ascii_lowercase()
                .ends_with(".m3u8")
                || response
                    .headers()
                    .get("content-type")
                    .and_then(|h| h.to_str().ok())
                    .is_some_and(|h| h.to_ascii_lowercase().contains("mpegurl"));
            if !hls && response.status().is_success() {
                if let Ok(Some(chunk)) = response.chunk().await {
                    hls =
                        chunk.starts_with(b"#EXTM3U") || chunk.starts_with(b"\xef\xbb\xbf#EXTM3U");
                }
            }
        }
    }
    let local = p.insert(url, referer, None).await?;
    Ok(if hls {
        format!("{local}/stream.m3u8")
    } else {
        local
    })
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn media_close(proxy_url: String) -> Result<(), String> {
    let p = service().await?;
    let token = proxy_url
        .strip_prefix(&format!("{}/", p.base))
        .ok_or("Invalid media handle")?;
    let token = token.strip_suffix("/stream.m3u8").unwrap_or(token);
    let mut map = p.entries.lock().await;
    if let Some(r) = map.get(token).cloned() {
        map.retain(|_, v| v.group != r.group);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> (Arc<Proxy>, Url, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .resolve("media.example.com", address)
            .build()
            .unwrap();
        let handle = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut raw = vec![0; 8192];
            let n = s.read(&mut raw).await.unwrap();
            let req = String::from_utf8_lossy(&raw[..n]).to_string();
            let lower = req.to_ascii_lowercase();
            let response = if lower.contains("range: bytes=2-4") {
                "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Range: bytes 2-4/10\r\nContent-Length: 3\r\n\r\n234"
            } else if lower.contains("range: bytes=90-") {
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */10\r\nContent-Length: 0\r\n\r\n"
            } else {
                "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 10\r\n\r\n0123456789"
            };
            s.write_all(response.as_bytes()).await.unwrap();
            req
        });
        (
            Proxy::start(client).await.unwrap(),
            Url::parse(&format!(
                "http://media.example.com:{}/movie.mp4",
                address.port()
            ))
            .unwrap(),
            handle,
        )
    }
    #[tokio::test]
    async fn ranges_and_referer_are_preserved() {
        let (p, url, h) = fixture().await;
        let local = p
            .insert(url, Some("https://provider.example.com/".into()), None)
            .await
            .unwrap();
        let r = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(local)
            .header("Range", "bytes=2-4")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 206);
        assert_eq!(r.headers()["content-range"], "bytes 2-4/10");
        assert_eq!(r.text().await.unwrap(), "234");
        assert!(h
            .await
            .unwrap()
            .contains("referer: https://provider.example.com/"));
    }
    #[tokio::test]
    async fn unsatisfiable_range_is_not_hidden() {
        let (p, url, h) = fixture().await;
        let local = p.insert(url, None, None).await.unwrap();
        let r = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(local)
            .header("Range", "bytes=90-")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 416);
        assert_eq!(r.headers()["content-range"], "bytes */10");
        h.await.unwrap();
    }
    #[tokio::test]
    async fn unauthorized_and_cross_origin_are_blocked() {
        let (p, url, h) = fixture().await;
        let c = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(
            c.get(format!("{}/guess", p.base))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        let local = p.insert(url, None, None).await.unwrap();
        assert_eq!(
            c.get(local)
                .header("Origin", "https://evil.example")
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        h.abort();
    }
    #[tokio::test]
    async fn rewrites_segments_variants_keys_and_reuses_tokens() {
        let (p, url, h) = fixture().await;
        let r = Resource {
            offline: None,
            url: url.clone(),
            referer: None,
            group: "root".into(),
            expires: Instant::now() + TTL,
        };
        p.entries.lock().await.insert("root".into(), r.clone());
        let text="#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"../key\"\nvariant/index.m3u8\nhttps://cdn.example.com/seg.ts\n";
        let rewritten = p.rewrite(text, &url, &r).await.unwrap();
        assert!(!rewritten.contains("cdn.example.com"));
        assert!(rewritten.contains(&format!("URI=\"{}/", p.base)));
        assert_eq!(p.entries.lock().await.len(), 4);
        assert_eq!(rewritten, p.rewrite(text, &url, &r).await.unwrap());
        assert!(p
            .rewrite("#EXTM3U\nhttp://127.0.0.1/private", &url, &r)
            .await
            .is_err());
        h.abort();
    }
    #[tokio::test]
    async fn first_bytes_arrive_before_upstream_finishes() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .resolve("stream.example.com", addr)
            .build()
            .unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut b = [0; 4096];
            s.read(&mut b).await.unwrap();
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 1000000000\r\n\r\nFIRST").await.unwrap();
            let _ = rx.await;
        });
        let p = Proxy::start(client).await.unwrap();
        let u = p
            .insert(
                Url::parse(&format!(
                    "http://stream.example.com:{}/movie.mp4",
                    addr.port()
                ))
                .unwrap(),
                None,
                None,
            )
            .await
            .unwrap();
        let mut response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(u)
            .send()
            .await
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(2), response.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(first.as_ref(), b"FIRST");
        let _ = tx.send(());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn map_capacity_and_expiration_are_bounded() {
        let (p, url, h) = fixture().await;
        let r = Resource {
            offline: None,
            url: url.clone(),
            referer: None,
            group: "root".into(),
            expires: Instant::now() + TTL,
        };
        {
            let mut map = p.entries.lock().await;
            for i in 0..MAX_RESOURCES {
                map.insert(i.to_string(), r.clone());
            }
        }
        assert!(p.insert(url.clone(), None, None).await.is_err());
        {
            let mut map = p.entries.lock().await;
            for r in map.values_mut() {
                r.expires = Instant::now() - Duration::from_secs(1);
            }
        }
        assert!(p.insert(url, None, None).await.is_ok());
        assert_eq!(p.entries.lock().await.len(), 1);
        h.abort();
    }
    #[tokio::test]
    async fn extensionless_variant_hint_and_revocation() {
        let (p, url, h) = fixture().await;
        let root = p.insert(url.clone(), None, None).await.unwrap();
        let token = root.rsplit('/').next().unwrap();
        let r = p.entries.lock().await.get(token).unwrap().clone();
        let out=p.rewrite("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant?id=2\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio?id=3\"\n",&url,&r).await.unwrap();
        assert_eq!(out.matches("/stream.m3u8").count(), 2);
        p.entries.lock().await.clear();
        assert!(p.rewrite("#EXTM3U\nsegment.ts\n", &url, &r).await.is_err());
        assert!(p.entries.lock().await.is_empty());
        h.abort();
    }
}
