//! Streaming offline HTTP responses. Paths are registered by native completed-library lookup only.
use std::path::Path;
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    net::TcpStream,
};

fn range_bounds(value: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(value) = value else { return Ok(None) };
    if size == 0 {
        return Err(());
    }
    let (a, b) = value
        .strip_prefix("bytes=")
        .ok_or(())?
        .split_once('-')
        .ok_or(())?;
    if value.contains(',') {
        return Err(());
    }
    let (start, end) = if a.is_empty() {
        let suffix = b.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = a.parse::<u64>().map_err(|_| ())?;
        let end = if b.is_empty() {
            size - 1
        } else {
            b.parse::<u64>().map_err(|_| ())?.min(size - 1)
        };
        (start, end)
    };
    if start >= size || end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}
async fn header(
    socket: &mut TcpStream,
    status: &str,
    size: u64,
    extra: Option<String>,
    headers: &[(String, String)],
) -> Result<(), String> {
    let mut text=format!("HTTP/1.1 {status}\r\nContent-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Length: {size}\r\nConnection: close\r\nCache-Control: no-store\r\n");
    if let Some(extra) = extra {
        text.push_str(&extra);
        text.push_str("\r\n");
    }
    for (k, v) in headers {
        if !k.is_empty()
            && k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            && !v.contains(['\r', '\n'])
        {
            text.push_str(k);
            text.push_str(": ");
            text.push_str(v);
            text.push_str("\r\n");
        }
    }
    text.push_str("\r\n");
    socket
        .write_all(text.as_bytes())
        .await
        .map_err(|_| "Offline response disconnected".into())
}
pub(crate) async fn serve(
    socket: &mut TcpStream,
    path: &Path,
    method: &str,
    range: Option<&str>,
    headers: &[(String, String)],
) -> Result<(), String> {
    if method != "GET" && method != "HEAD" {
        return header(socket, "405 Method Not Allowed", 0, None, headers).await;
    }
    // Reject replaced symlinks after capability registration as well as on registration.
    let metadata = tokio::fs::symlink_metadata(path).await;
    if metadata
        .as_ref()
        .map_or(true, |m| !m.is_file() || m.file_type().is_symlink())
    {
        return header(socket, "404 Not Found", 0, None, headers).await;
    }
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return header(socket, "404 Not Found", 0, None, headers).await,
    };
    let size = file
        .metadata()
        .await
        .map_err(|_| "Offline metadata unavailable")?
        .len();
    let bounds = match range_bounds(if method == "HEAD" { None } else { range }, size) {
        Ok(b) => b,
        Err(_) => {
            return header(
                socket,
                "416 Range Not Satisfiable",
                0,
                Some(format!("Content-Range: bytes */{size}")),
                headers,
            )
            .await
        }
    };
    let (start, length, status, extra) = match bounds {
        Some((start, end)) => (
            start,
            end - start + 1,
            "206 Partial Content",
            Some(format!("Content-Range: bytes {start}-{end}/{size}")),
        ),
        None => (0, size, "200 OK", None),
    };
    header(socket, status, length, extra, headers).await?;
    if method == "HEAD" {
        return Ok(());
    }
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|_| "Offline seek failed")?;
    let mut remaining = length;
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let take = remaining.min(buffer.len() as u64) as usize;
        let n = file
            .read(&mut buffer[..take])
            .await
            .map_err(|_| "Offline media read failed")?;
        if n == 0 {
            return Err("Offline file changed during playback".into());
        }
        socket
            .write_all(&buffer[..n])
            .await
            .map_err(|_| "Offline player disconnected")?;
        remaining -= n as u64;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn range_semantics() {
        assert_eq!(range_bounds(None, 20_000_000), Ok(None));
        assert_eq!(
            range_bounds(Some("bytes=0-"), 20_000_000),
            Ok(Some((0, 19_999_999)))
        );
        assert_eq!(range_bounds(Some("bytes=-2"), 10), Ok(Some((8, 9))));
        for h in [
            "bytes=10-",
            "bytes=2-1",
            "bytes=-0",
            "bytes=0-1,4-5",
            "bytes=18446744073709551616-",
        ] {
            assert!(range_bounds(Some(h), 10).is_err());
        }
    }
    #[tokio::test]
    async fn actual_tcp_stream_preserves_status_ranges_and_body() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("owned.mp4");
        std::fs::write(&path, b"0123456789").unwrap();
        for (method, range, status, body) in [
            ("GET", None, "200 OK", "0123456789"),
            ("GET", Some("bytes=3-5"), "206 Partial Content", "345"),
            ("GET", Some("bytes=20-"), "416 Range Not Satisfiable", ""),
            ("HEAD", None, "200 OK", ""),
            ("HEAD", Some("bytes=3-5"), "200 OK", ""),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let path = path.clone();
            let worker = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                serve(&mut socket, &path, method, range, &[]).await.unwrap();
            });
            let mut socket = TcpStream::connect(addr).await.unwrap();
            let mut response = String::new();
            socket.read_to_string(&mut response).await.unwrap();
            worker.await.unwrap();
            let (head, data) = response.split_once("\r\n\r\n").unwrap();
            assert!(head.starts_with(&format!("HTTP/1.1 {status}")));
            assert_eq!(data, body);
            if status.starts_with("206") {
                assert!(head.contains("Content-Range: bytes 3-5/10"));
            }
            if status.starts_with("416") {
                assert!(head.contains("Content-Range: bytes */10"));
            }
        }
    }
}
#[cfg(test)]
mod large_file_test {
    use super::*;
    #[tokio::test]
    async fn no_range_streams_more_than_old_protocol_cap() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("large.mp4");
        let length = 4 * 1024 * 1024 + 17;
        std::fs::File::create(&path)
            .unwrap()
            .set_len(length)
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let worker = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            serve(&mut socket, &path, "GET", None, &[]).await.unwrap();
        });
        let mut socket = TcpStream::connect(addr).await.unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).await.unwrap();
        worker.await.unwrap();
        let split = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&response[..split]);
        assert!(head.starts_with("HTTP/1.1 200 OK"));
        assert!(head.contains(&format!("Content-Length: {length}")));
        assert_eq!(response.len() - split - 4, length as usize);
    }
}
