use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU8, Ordering},
};
use tokio::sync::Notify;
pub(crate) const MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;
pub(crate) const RANGE_CHUNK: u64 = 4 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Job {
    pub(crate) anime_meta: Value,
    pub(crate) episode_meta: Value,
    pub(crate) url: String,
    pub(crate) file_path: String,
    pub(crate) percent: f64,
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) validator: Option<String>,
    #[serde(default)]
    pub(crate) error: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Manifest {
    pub(crate) jobs: BTreeMap<String, Job>,
}
#[derive(Default)]
pub(crate) struct Control {
    pub(crate) action: AtomicU8,
    pub(crate) notify: Notify,
}
impl Control {
    pub(crate) fn stop(&self, action: u8) {
        self.action.fetch_max(action, Ordering::SeqCst);
        self.notify.notify_one();
    }
}
pub(crate) fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub(crate) fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 260
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.' || c == b'_')
        && !name.starts_with('.')
        && !name.contains("..")
}
pub(crate) fn owned(root: &Path, name: &str) -> Result<PathBuf, String> {
    if !safe_name(name) {
        return Err("Invalid offline media identifier".into());
    }
    let path = root.join(name);
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err("Unsafe offline file".into());
        }
    }
    Ok(path)
}
pub(crate) fn id(v: &Value) -> Result<String, String> {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return Err("Invalid episode identifier".into()),
    };
    if s.is_empty() || s.len() > 48 {
        return Err("Invalid episode identifier length".into());
    }
    Ok(s.bytes().map(|b| format!("{b:02x}")).collect())
}
pub(crate) fn key(a: &Value, e: &Value) -> Result<String, String> {
    Ok(format!("{}-{}", id(a)?, id(e)?))
}
pub(crate) fn save(root: &Path, data: &Manifest) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(root).map_err(err)?;
    struct Limited<'a> {
        file: &'a mut tempfile::NamedTempFile,
        remaining: usize,
    }
    impl std::io::Write for Limited<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.remaining {
                return Err(std::io::Error::other(
                    "Offline manifest exceeds 8 MiB limit",
                ));
            }
            let n = std::io::Write::write(self.file, bytes)?;
            self.remaining -= n;
            Ok(n)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            std::io::Write::flush(self.file)
        }
    }
    serde_json::to_writer(
        Limited {
            file: &mut file,
            remaining: 8 * 1024 * 1024,
        },
        data,
    )
    .map_err(err)?;
    file.as_file_mut().sync_all().map_err(err)?;
    file.persist(root.join("manifest.json")).map_err(err)?;
    Ok(())
}
pub(crate) fn content_range(value: &str) -> Result<(u64, u64, u64), String> {
    let (range, total) = value
        .strip_prefix("bytes ")
        .ok_or("Invalid Content-Range")?
        .split_once('/')
        .ok_or("Invalid Content-Range")?;
    let (start, end) = range.split_once('-').ok_or("Invalid Content-Range")?;
    let (start, end, total) = (
        start.parse::<u64>().map_err(err)?,
        end.parse::<u64>().map_err(err)?,
        total.parse::<u64>().map_err(err)?,
    );
    if start > end || end >= total {
        return Err("Invalid Content-Range bounds".into());
    }
    Ok((start, end, total))
}
/// Parse a single byte range, rejecting multipart ranges and unsatisfiable positions.
pub(crate) fn byte_range(header: Option<&str>, size: u64) -> Result<(u64, u64, bool), String> {
    if size == 0 {
        return Err("Empty media".into());
    }
    let Some(h) = header else {
        return if size <= RANGE_CHUNK {
            Ok((0, size - 1, false))
        } else {
            Err("Range required for large media".into())
        };
    };
    let raw = h.strip_prefix("bytes=").ok_or("Invalid Range unit")?;
    if raw.contains(',') {
        return Err("Multiple ranges unsupported".into());
    }
    let (a, b) = raw.split_once('-').ok_or("Invalid Range")?;
    let (start, end) = if a.is_empty() {
        let suffix = b.parse::<u64>().map_err(err)?;
        if suffix == 0 {
            return Err("Empty suffix".into());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = a.parse::<u64>().map_err(err)?;
        let end = if b.is_empty() {
            size - 1
        } else {
            b.parse::<u64>().map_err(err)?.min(size - 1)
        };
        (start, end)
    };
    if start >= size || start > end {
        return Err("Unsatisfiable Range".into());
    }
    Ok((start, end.min(start.saturating_add(RANGE_CHUNK - 1)), true))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn ranges() {
        assert_eq!(byte_range(Some("bytes=2-4"), 10).unwrap(), (2, 4, true));
        assert_eq!(byte_range(Some("bytes=-3"), 10).unwrap(), (7, 9, true));
        assert_eq!(byte_range(Some("bytes=9-"), 10).unwrap(), (9, 9, true));
        for r in [
            "bytes=10-",
            "bytes=-0",
            "bytes=5-2",
            "bytes=0-1,3-4",
            "items=0-2",
            "bytes=18446744073709551616-",
        ] {
            assert!(byte_range(Some(r), 10).is_err(), "{r}");
        }
        assert!(byte_range(None, MAX_BYTES).is_err());
        assert_eq!(
            byte_range(Some("bytes=0-"), MAX_BYTES).unwrap().1,
            RANGE_CHUNK - 1
        );
    }
    #[test]
    fn containment() {
        let t = tempfile::tempdir().unwrap();
        for p in ["../escape", "/etc/passwd", "C:\\test", "a/b", "..", "a%2fb"] {
            assert!(owned(t.path(), p).is_err());
        }
        assert!(owned(t.path(), "12-34.mp4").is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_rejected() {
        let t = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/etc/passwd", t.path().join("evil.mp4")).unwrap();
        assert!(owned(t.path(), "evil.mp4").is_err());
    }
    #[test]
    fn atomic_manifest() {
        let t = tempfile::tempdir().unwrap();
        let m = Manifest::default();
        save(t.path(), &m).unwrap();
        save(t.path(), &m).unwrap();
        let _: Manifest =
            serde_json::from_reader(fs::File::open(t.path().join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(fs::read_dir(t.path()).unwrap().count(), 1);
    }
    #[test]
    fn cancel_state() {
        let c = Control::default();
        assert_eq!(c.action.load(Ordering::SeqCst), 0);
        c.stop(1);
        assert_eq!(c.action.load(Ordering::SeqCst), 1);
        c.stop(2);
        assert_eq!(c.action.load(Ordering::SeqCst), 2);
        c.stop(1);
        assert_eq!(c.action.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn resume_validation() {
        assert_eq!(content_range("bytes 100-199/200").unwrap(), (100, 199, 200));
        for s in [
            "bytes 100-99/200",
            "bytes 0-200/200",
            "bytes */200",
            "items 0-1/2",
        ] {
            assert!(content_range(s).is_err());
        }
    }
    #[test]
    fn ids_are_not_paths() {
        assert_ne!(
            key(&json!("a/b"), &json!("c")).unwrap(),
            key(&json!("a"), &json!("b/c")).unwrap()
        );
        assert!(safe_name(&format!(
            "{}.mp4",
            key(&json!("../"), &json!(12)).unwrap()
        )));
    }
}

/// Shared by the protocol handler and tests; never allocates a full episode.
pub(crate) fn read_chunk(file: &mut fs::File, start: u64, end: u64) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let length = end
        .checked_sub(start)
        .and_then(|n| n.checked_add(1))
        .filter(|n| *n <= RANGE_CHUNK)
        .ok_or("Invalid media chunk bounds")?;
    let mut body = vec![0; length as usize];
    file.seek(SeekFrom::Start(start)).map_err(err)?;
    file.read_exact(&mut body).map_err(err)?;
    Ok(body)
}
#[cfg(test)]
mod io_tests {
    use super::*;
    #[test]
    fn seek_reads_exact_bytes_and_bounds_memory() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("sample.mp4");
        fs::write(&p, b"0123456789").unwrap();
        let mut f = fs::File::open(p).unwrap();
        for (header, expected) in [
            ("bytes=2-5", b"2345".as_slice()),
            ("bytes=-2", b"89".as_slice()),
            ("bytes=9-", b"9".as_slice()),
        ] {
            let (start, end, partial) = byte_range(Some(header), 10).unwrap();
            assert!(partial);
            assert_eq!(read_chunk(&mut f, start, end).unwrap(), expected);
        }
        assert!(read_chunk(&mut f, 0, MAX_BYTES).is_err());
        assert!(read_chunk(&mut f, 5, 3).is_err());
        assert!(read_chunk(&mut f, 9, 10).is_err());
    }
    #[test]
    fn invalid_manifest_does_not_overwrite_existing() {
        let t = tempfile::tempdir().unwrap();
        save(t.path(), &Manifest::default()).unwrap();
        let before = fs::read(t.path().join("manifest.json")).unwrap();
        let parsed = serde_json::from_slice::<Manifest>(b"broken");
        assert!(parsed.is_err());
        assert_eq!(fs::read(t.path().join("manifest.json")).unwrap(), before);
    }
}
#[cfg(test)]
mod manifest_limit_test {
    use super::*;
    #[test]
    fn oversized_manifest_preserves_previous_atomic_file() {
        let t = tempfile::tempdir().unwrap();
        save(t.path(), &Manifest::default()).unwrap();
        let before = fs::read(t.path().join("manifest.json")).unwrap();
        let mut manifest = Manifest::default();
        manifest.jobs.insert(
            "x".into(),
            Job {
                anime_meta: Value::String("a".repeat(8 * 1024 * 1024)),
                episode_meta: Value::Null,
                url: String::new(),
                file_path: "x.mp4".into(),
                percent: 0.,
                status: "paused".into(),
                validator: None,
                error: None,
            },
        );
        assert!(save(t.path(), &manifest).is_err());
        assert_eq!(fs::read(t.path().join("manifest.json")).unwrap(), before);
        assert_eq!(fs::read_dir(t.path()).unwrap().count(), 1);
    }
}

pub(crate) fn reject_text_media(prefix: &mut Vec<u8>, chunk: &[u8]) -> bool {
    let count = (64usize.saturating_sub(prefix.len())).min(chunk.len());
    prefix.extend_from_slice(&chunk[..count]);
    let text = String::from_utf8_lossy(prefix);
    let text = text
        .trim_start_matches('\u{feff}')
        .trim_start()
        .to_ascii_lowercase();
    text.starts_with("#extm3u") || text.starts_with("<!doctype html") || text.starts_with("<html")
}
#[cfg(test)]
mod sniff_tests {
    use super::*;
    #[test]
    fn split_playlist_never_published_as_mp4() {
        let mut prefix = vec![];
        assert!(!reject_text_media(&mut prefix, b"#EXT"));
        assert!(reject_text_media(&mut prefix, b"M3U\n#EXTINF"));
        assert!(reject_text_media(&mut vec![], b"\xef\xbb\xbf #EXTM3U"));
        assert!(!reject_text_media(&mut vec![], b"\x00\x00\x00\x18ftypmp42"));
    }
}

/// Decide truncation/append before opening a .part file. A server ignoring Range must restart.
pub(crate) fn resume_layout(
    status: u16,
    offset: u64,
    length: Option<u64>,
    header: Option<&str>,
) -> Result<(u64, Option<u64>), String> {
    let layout = if status == 200 {
        (0, length)
    } else if status == 206 && offset > 0 {
        let (start, end, total) = content_range(header.ok_or("Missing Content-Range")?)?;
        if start != offset || end + 1 != total || length.is_some_and(|n| n != end - start + 1) {
            return Err("Invalid resume range".into());
        }
        (offset, Some(total))
    } else {
        return Err(format!(
            "Unexpected download HTTP status {status}; retry to restart"
        ));
    };
    if layout.1.is_some_and(|n| n > MAX_BYTES) {
        return Err("Episode exceeds 16 GiB limit".into());
    }
    Ok(layout)
}
#[cfg(test)]
mod resume_tests {
    use super::*;
    #[test]
    fn ignored_range_restarts_instead_of_appending() {
        assert_eq!(
            resume_layout(200, 100, Some(400), None).unwrap(),
            (0, Some(400))
        );
    }
    #[test]
    fn validated_partial_is_appended() {
        assert_eq!(
            resume_layout(206, 100, Some(100), Some("bytes 100-199/200")).unwrap(),
            (100, Some(200))
        );
    }
    #[test]
    fn wrong_partial_never_appends() {
        for header in [
            None,
            Some("bytes 0-99/200"),
            Some("bytes 100-149/200"),
            Some("bytes */200"),
        ] {
            assert!(resume_layout(206, 100, Some(100), header).is_err());
        }
        assert!(resume_layout(206, 100, Some(99), Some("bytes 100-199/200")).is_err());
        assert!(resume_layout(206, 0, Some(100), Some("bytes 0-99/100")).is_err());
        assert!(resume_layout(416, 100, None, None).is_err());
        assert!(resume_layout(200, 0, Some(MAX_BYTES + 1), None).is_err());
    }
}
