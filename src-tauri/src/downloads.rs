//! Owned offline storage, bounded transfers and resumable queue. No renderer paths are trusted.
use crate::offline_core::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, State};
use tauri_plugin_opener::OpenerExt;
use tokio::{io::AsyncWriteExt, sync::Semaphore};
struct Inner {
    root: PathBuf,
    manifest: Mutex<Manifest>,
    controls: Mutex<BTreeMap<String, Arc<Control>>>,
    slots: Arc<Semaphore>,
    client: reqwest::Client,
}
#[derive(Clone)]
pub struct Downloads(Arc<Inner>);
impl Downloads {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        if fs::symlink_metadata(&root).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Offline storage must not be a symlink".into());
        }
        fs::create_dir_all(&root).map_err(err)?;
        let root = root.canonicalize().map_err(err)?;
        let manifest_path = owned(&root, "manifest.json")?;
        let mut manifest: Manifest = if manifest_path.exists() {
            if fs::metadata(&manifest_path).map_err(err)?.len() > 8 * 1024 * 1024 {
                return Err("Offline manifest exceeds limit".into());
            }
            serde_json::from_reader(fs::File::open(manifest_path).map_err(err)?).map_err(err)?
        } else {
            Manifest::default()
        };
        for (stored_key, job) in manifest.jobs.iter_mut() {
            if *stored_key != key(&job.anime_meta["id"], &job.episode_meta["id"])?
                || job.file_path != format!("{stored_key}.mp4")
            {
                return Err("Invalid offline manifest entry".into());
            }
            let media = owned(&root, &job.file_path)?;
            if media.is_file() && fs::metadata(&media).map_err(err)?.len() > 0 {
                job.status = "completed".into();
                job.percent = 100.;
            }
            if job.status == "downloading" || job.status == "queued" {
                job.status = "paused".into();
                job.percent = -3.;
            }
        }
        save(&root, &manifest)?;
        let client = crate::network::client_builder()
            .timeout(Duration::from_secs(24 * 3600))
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60))
            .no_gzip()
            .no_brotli()
            .build()
            .map_err(err)?;
        Ok(Self(Arc::new(Inner {
            root,
            manifest: Mutex::new(manifest),
            controls: Mutex::new(BTreeMap::new()),
            slots: Arc::new(Semaphore::new(1)),
            client,
        })))
    }
    fn update(&self, key: &str, f: impl FnOnce(&mut Job)) -> Result<Job, String> {
        let mut m = self.0.manifest.lock().map_err(err)?;
        let previous = m.jobs.get(key).ok_or("Download not found")?.clone();
        let job = m.jobs.get_mut(key).ok_or("Download not found")?;
        f(job);
        let job = job.clone();
        if let Err(error) = save(&self.0.root, &m) {
            m.jobs.insert(key.into(), previous);
            return Err(error);
        }
        Ok(job)
    }
    fn event(app: &tauri::AppHandle, event: &str, job: &Job) {
        let _ = app.emit(event, json!({"animeId":job.anime_meta["id"],"episodeId":job.episode_meta["id"],"percent":job.percent,"status":job.status,"error":job.error}));
    }
    fn start(&self, app: tauri::AppHandle, k: String) -> Result<bool, String> {
        let control = Arc::new(Control::default());
        {
            let mut controls = self.0.controls.lock().map_err(err)?;
            if controls.contains_key(&k) {
                return Ok(false);
            }
            controls.insert(k.clone(), control.clone());
        }
        let job = match self.update(&k, |j| {
            j.status = "queued".into();
            j.percent = -2.;
            j.error = None;
        }) {
            Ok(j) => j,
            Err(e) => {
                self.0.controls.lock().unwrap().remove(&k);
                return Err(e);
            }
        };
        Self::event(&app, "offline:progress", &job);
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let permit = tokio::select! { p = this.0.slots.clone().acquire_owned() => p.ok(), _ = control.notify.notified() => None };
            let result = if permit.is_some() && control.action.load(Ordering::SeqCst) == 0 {
                this.transfer(&app, &k, &control).await
            } else {
                Err("Interrupted".into())
            };
            // Keep control registered until file handles are closed; resume/delete cannot race cleanup.
            let action = control.action.load(Ordering::SeqCst);
            let status = if result.is_ok() {
                "completed"
            } else if action == 2 {
                "cancelled"
            } else if action == 1 {
                "paused"
            } else {
                "error"
            };
            if status == "cancelled" {
                if let Ok(j) = this.0.manifest.lock().map(|m| m.jobs.get(&k).cloned()) {
                    if let Some(j) = j {
                        if let Ok(p) = owned(&this.0.root, &format!("{}.part", j.file_path)) {
                            let _ = fs::remove_file(p);
                        }
                    }
                }
            }
            let finished = this.update(&k, |j| {
                j.status = status.into();
                j.percent = match status {
                    "completed" => 100.,
                    "paused" => -3.,
                    "cancelled" => -1.,
                    _ => j.percent,
                };
                j.error = if status == "error" {
                    result.err()
                } else {
                    None
                };
            });
            this.0.controls.lock().unwrap().remove(&k);
            if let Ok(j) = finished {
                Self::event(
                    &app,
                    if status == "error" {
                        "offline:error"
                    } else if status == "completed" {
                        "offline:completed"
                    } else {
                        "offline:progress"
                    },
                    &j,
                );
                if status == "completed" {
                    Self::event(&app, "offline:progress", &j);
                }
            } else if let Ok(mut manifest) = this.0.manifest.lock() {
                if let Some(job) = manifest.jobs.get_mut(&k) {
                    job.status = "error".into();
                    job.error=Some("Не удалось сохранить состояние библиотеки. Проверьте свободное место и повторите операцию.".into());
                    Self::event(&app, "offline:error", job);
                }
            }
        });
        Ok(true)
    }
    async fn transfer(
        &self,
        app: &tauri::AppHandle,
        k: &str,
        control: &Control,
    ) -> Result<(), String> {
        let job = self.update(k, |j| {
            j.status = "downloading".into();
            j.percent = 0.;
        })?;
        // Atomic publication may have succeeded before a manifest write failed.
        let final_path = owned(&self.0.root, &job.file_path)?;
        if fs::metadata(&final_path).is_ok_and(|m| m.len() > 0) {
            return Ok(());
        }
        let part = owned(&self.0.root, &format!("{}.part", job.file_path))?;
        if job.url.contains("m3u8") || job.url.contains(":hls:") {
            self.hls(&job, &part, control).await?;
        } else {
            self.direct(app, k, &job, &part, control).await?;
        }
        if control.action.load(Ordering::SeqCst) != 0 {
            return Err("Interrupted".into());
        }
        let destination = owned(&self.0.root, &job.file_path)?;
        tokio::fs::rename(part, destination).await.map_err(err)?;
        Ok(())
    }
    async fn direct(
        &self,
        app: &tauri::AppHandle,
        k: &str,
        job: &Job,
        part: &Path,
        control: &Control,
    ) -> Result<(), String> {
        // Only resume with a persisted entity validator; never append a different representation.
        let mut offset = if job.validator.is_some() {
            fs::metadata(part).map(|m| m.len()).unwrap_or(0)
        } else {
            0
        };
        let mut request = self
            .0
            .client
            .get(&job.url)
            .header("Accept-Encoding", "identity")
            .header("Referer", referer(&job.url));
        if offset > 0 {
            request = request
                .header("Range", format!("bytes={offset}-"))
                .header("If-Range", job.validator.as_deref().unwrap());
        }
        let mut response = tokio::select! { r=request.send()=>r.map_err(|_|"Media request failed")?, _=control.notify.notified()=>return Err("Interrupted".into()) };
        let status = response.status();
        if response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().contains("mpegurl"))
        {
            return Err("Загрузка HLS пока недоступна; выберите прямой MP4 источник".into());
        }
        let (resolved_offset, total) = resume_layout(
            status.as_u16(),
            offset,
            response.content_length(),
            response
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok()),
        )?;
        offset = resolved_offset;
        if response
            .headers()
            .get("content-encoding")
            .is_some_and(|h| h != "identity")
        {
            return Err("Compressed download response not supported".into());
        }
        let validator = response
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.starts_with("W/"))
            .or_else(|| {
                response
                    .headers()
                    .get("last-modified")
                    .and_then(|v| v.to_str().ok())
            })
            .map(String::from);
        if offset > 0 && validator.as_ref() != job.validator.as_ref() {
            return Err("Media changed since pause; retry to restart".into());
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(offset == 0)
            .append(offset > 0)
            .open(part)
            .await
            .map_err(err)?;
        self.update(k, |j| j.validator = validator)?;
        let mut count = offset;
        let mut prefix = Vec::new();
        let mut last = Instant::now();
        loop {
            let chunk = tokio::select! { c=response.chunk()=>c.map_err(|_|"Media transfer interrupted")?, _=control.notify.notified()=>return Err("Interrupted".into()) };
            let Some(chunk) = chunk else { break };
            if offset == 0 && reject_text_media(&mut prefix, &chunk) {
                file.set_len(0).await.map_err(err)?;
                self.update(k, |j| j.validator = None)?;
                return Err("Источник вернул HLS-плейлист или HTML, а не прямое видео. Выберите MP4 источник.".into());
            }
            count = count
                .checked_add(chunk.len() as u64)
                .ok_or("File too large")?;
            if count > MAX_BYTES {
                return Err("Episode exceeds 16 GiB limit".into());
            }
            file.write_all(&chunk).await.map_err(err)?;
            if last.elapsed() > Duration::from_millis(500) {
                let percent = total
                    .filter(|n| *n > 0)
                    .map(|n| (count as f64 / n as f64 * 100.).min(99.))
                    .unwrap_or(0.);
                let j = {
                    let mut m = self.0.manifest.lock().map_err(err)?;
                    let j = m.jobs.get_mut(k).ok_or("Missing job")?;
                    j.percent = percent;
                    j.clone()
                };
                Self::event(app, "offline:progress", &j);
                last = Instant::now();
            }
        }
        if count == 0 || total.is_some_and(|n| n != count) {
            return Err("Incomplete or empty media response".into());
        }
        file.sync_all().await.map_err(err)?;
        Ok(())
    }
    async fn hls(&self, _job: &Job, _part: &Path, _control: &Control) -> Result<(), String> {
        Err("Загрузка HLS пока недоступна: безопасная обработка плейлистов ещё не перенесена. Прямые MP4 можно скачать; онлайн-просмотр HLS остаётся доступен. FFmpeg автоматически не устанавливается.".into())
    }
}

fn referer(url: &str) -> &'static str {
    if url.contains("sibnet.ru") {
        "https://video.sibnet.ru/"
    } else if url.contains("libria") {
        "https://anilibria.tv/"
    } else {
        "https://kodik.info/"
    }
}
#[tauri::command]
pub fn offline_get_library(state: State<'_, Downloads>) -> Result<Value, String> {
    let state = state.inner();
    let m = state.0.manifest.lock().map_err(err)?;
    let mut library: Vec<Value> = Vec::new();
    for job in m.jobs.values().filter(|j| j.status == "completed") {
        if !owned(&state.0.root, &job.file_path)?.exists() {
            continue;
        }
        let index=library.iter().position(|a|a["id"]==job.anime_meta["id"]).unwrap_or_else(|| {library.push(json!({"id":job.anime_meta["id"],"title":job.anime_meta["title"],"image":job.anime_meta["image"],"episodes":[]})); library.len()-1});
        library[index]["episodes"].as_array_mut().unwrap().push(json!({"id":job.episode_meta["id"],"title":job.episode_meta["title"],"filePath":job.file_path}));
    }
    Ok(json!(library))
}
#[tauri::command]
pub fn offline_get_active_downloads(state: State<'_, Downloads>) -> Result<Value, String> {
    let state = state.inner();
    let m = state.0.manifest.lock().map_err(err)?;
    Ok(Value::Array(m.jobs.iter().filter(|(_,j)|j.status!="completed"&&j.status!="cancelled").map(|(k,j)|json!({"downloadId":k,"animeMeta":j.anime_meta,"episodeMeta":j.episode_meta,"percent":j.percent,"status":j.status,"error":j.error})).collect()))
}
#[tauri::command]
pub fn offline_download_episode(
    app: tauri::AppHandle,
    state: State<'_, Downloads>,
    anime_meta: Value,
    episode_meta: Value,
    url: String,
) -> Result<bool, String> {
    let state = state.inner();
    let parsed = crate::network::validate_url(&url)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || url.len() > 8192
    {
        return Err("Only HTTP/S media URLs are allowed".into());
    }
    if serde_json::to_vec(&anime_meta).map_err(err)?.len() > 32768
        || serde_json::to_vec(&episode_meta).map_err(err)?.len() > 32768
    {
        return Err("Metadata exceeds limit".into());
    }
    if url.contains("m3u8") || url.contains(":hls:") {
        return Err("Загрузка HLS пока недоступна: требуется перенос безопасной обработки плейлистов. Прямые MP4 можно скачать; онлайн-просмотр HLS остаётся доступен.".into());
    }
    let k = key(&anime_meta["id"], &episode_meta["id"])?;
    if state.0.controls.lock().map_err(err)?.contains_key(&k) {
        return Ok(false);
    }
    {
        let mut m = state.0.manifest.lock().map_err(err)?;
        if m.jobs.get(&k).is_some_and(|j| j.status != "cancelled") {
            return Ok(false);
        }
        if m.jobs.len() >= 10000 {
            return Err("Offline library limit reached".into());
        }
        let previous = m.jobs.insert(
            k.clone(),
            Job {
                anime_meta,
                episode_meta,
                url,
                file_path: format!("{k}.mp4"),
                percent: -2.,
                status: "queued".into(),
                validator: None,
                error: None,
            },
        );
        if let Err(error) = save(&state.0.root, &m) {
            m.jobs.remove(&k);
            if let Some(previous) = previous {
                m.jobs.insert(k.clone(), previous);
            }
            return Err(error);
        }
    }
    state.start(app, k)
}
fn stop(state: &Downloads, anime_id: Value, episode_id: Value, action: u8) -> Result<bool, String> {
    let k = key(&anime_id, &episode_id)?;
    {
        let c = state.0.controls.lock().map_err(err)?;
        if let Some(c) = c.get(&k) {
            c.stop(action);
            return Ok(true);
        }
    }
    let j = state.update(&k, |j| {
        if j.status != "completed" {
            j.status = if action == 2 { "cancelled" } else { "paused" }.into();
            j.percent = if action == 2 { -1. } else { -3. };
        }
    })?;
    if action == 2 {
        let p = owned(&state.0.root, &format!("{}.part", j.file_path))?;
        if p.exists() {
            fs::remove_file(p).map_err(err)?;
        }
    }
    Ok(true)
}
#[tauri::command]
pub fn offline_pause_download(
    state: State<'_, Downloads>,
    anime_id: Value,
    episode_id: Value,
) -> Result<bool, String> {
    let state = state.inner();
    stop(&state, anime_id, episode_id, 1)
}
#[tauri::command]
pub fn offline_cancel_download(
    state: State<'_, Downloads>,
    anime_id: Value,
    episode_id: Value,
) -> Result<bool, String> {
    let state = state.inner();
    stop(&state, anime_id, episode_id, 2)
}
#[tauri::command]
pub fn offline_resume_download(
    app: tauri::AppHandle,
    state: State<'_, Downloads>,
    anime_id: Value,
    episode_id: Value,
) -> Result<bool, String> {
    let state = state.inner();
    let k = key(&anime_id, &episode_id)?;
    {
        let m = state.0.manifest.lock().map_err(err)?;
        if m.jobs.get(&k).is_some_and(|j| j.status == "completed") {
            return Ok(false);
        }
    }
    state.start(app, k)
}
#[tauri::command]
pub fn offline_retry_download(
    app: tauri::AppHandle,
    state: State<'_, Downloads>,
    anime_id: Value,
    episode_id: Value,
) -> Result<bool, String> {
    let state = state.inner();
    let k = key(&anime_id, &episode_id)?;
    if state.0.controls.lock().map_err(err)?.contains_key(&k) {
        return Ok(false);
    }
    {
        let m = state.0.manifest.lock().map_err(err)?;
        if m.jobs.get(&k).is_some_and(|j| j.status == "completed") {
            return Ok(false);
        }
    }
    state.update(&k, |j| j.validator = None)?;
    state.start(app, k)
}
#[tauri::command]
pub fn offline_delete_episode(
    state: State<'_, Downloads>,
    anime_id: Value,
    episode_id: Value,
) -> Result<bool, String> {
    let state = state.inner();
    let k = key(&anime_id, &episode_id)?;
    if state.0.controls.lock().map_err(err)?.contains_key(&k) {
        return Err("Сначала отмените загрузку и дождитесь её остановки".into());
    }
    let mut m = state.0.manifest.lock().map_err(err)?;
    let Some(j) = m.jobs.get(&k) else {
        return Ok(false);
    };
    for name in [&j.file_path, &format!("{}.part", j.file_path)] {
        let p = owned(&state.0.root, name)?;
        if p.exists() {
            fs::remove_file(p).map_err(err)?;
        }
    }
    m.jobs.remove(&k);
    save(&state.0.root, &m)?;
    Ok(true)
}
#[tauri::command]
pub fn offline_open_folder(
    app: tauri::AppHandle,
    state: State<'_, Downloads>,
) -> Result<(), String> {
    let state = state.inner();
    app.opener()
        .open_path(state.0.root.to_string_lossy().as_ref(), None::<&str>)
        .map_err(err)
}

/// Called on a blocking worker by register_asynchronous_uri_scheme_protocol("offline", ...).
/// Only completed manifest entries can be served; no filesystem path is accepted.
pub fn media_response(
    state: &Downloads,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::Response;
    let failure = |status, extra: Option<(String, String)>| {
        let mut b = Response::builder()
            .status(status)
            .header("Access-Control-Allow-Origin", "*")
            .header("Accept-Ranges", "bytes");
        if let Some((k, v)) = extra {
            b = b.header(k, v);
        }
        b.body(Vec::new()).unwrap()
    };
    if request.method() != "GET" && request.method() != "HEAD" {
        return failure(405, None);
    }
    let name = request.uri().path().trim_start_matches('/');
    if !safe_name(name) {
        return failure(404, None);
    }
    let allowed = state
        .0
        .manifest
        .lock()
        .map(|m| {
            m.jobs
                .values()
                .any(|j| j.status == "completed" && j.file_path == name)
        })
        .unwrap_or(false);
    if !allowed {
        return failure(404, None);
    }
    let result = (|| -> Result<_, String> {
        let path = owned(&state.0.root, name)?;
        let file = fs::File::open(path).map_err(err)?;
        let size = file.metadata().map_err(err)?.len();
        Ok((file, size))
    })();
    let Ok((mut file, size)) = result else {
        return failure(404, None);
    };
    let range = request.headers().get("range").and_then(|h| h.to_str().ok());
    if request.method() == "HEAD" {
        return Response::builder()
            .status(200)
            .header("Content-Type", "video/mp4")
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", size)
            .header("Access-Control-Allow-Origin", "*")
            .body(vec![])
            .unwrap();
    }
    let Ok((start, end, partial)) = byte_range(range, size) else {
        return failure(
            if range.is_none() && size > RANGE_CHUNK {
                413
            } else {
                416
            },
            Some(("Content-Range".into(), format!("bytes */{size}"))),
        );
    };
    let Ok(body) = read_chunk(&mut file, start, end) else {
        return failure(500, None);
    };
    let mut response = Response::builder()
        .status(if partial { 206 } else { 200 })
        .header("Content-Type", "video/mp4")
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", body.len())
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store");
    if partial {
        response = response.header("Content-Range", format!("bytes {start}-{end}/{size}"));
    }
    response.body(body).unwrap()
}

/// Export is the only write outside owned storage, authorized by a native Save dialog.
/// Renderer-supplied default_file_name is never treated as a destination path.
#[tauri::command]
pub async fn download_episode(
    app: tauri::AppHandle,
    state: State<'_, Downloads>,
    url: String,
    default_file_name: Option<String>,
    referer: Option<String>,
) -> Result<Value, String> {
    // Own the cheap Arc-backed handle across awaits, not the IPC State borrow.
    let downloads = state.inner().clone();
    Ok(
        match export_episode(&app, &downloads, url, default_file_name, referer).await {
            Ok(Some(path)) => json!({"success":true,"filePath":path}),
            Ok(None) => json!({"success":false,"canceled":true}),
            Err(error) => json!({"success":false,"error":error}),
        },
    )
}
async fn export_episode(
    app: &tauri::AppHandle,
    state: &Downloads,
    url: String,
    default_file_name: Option<String>,
    referer_header: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let url = if url.starts_with("//") {
        format!("https:{url}")
    } else {
        url
    };
    crate::network::validate_url(&url)?;
    if url.contains("m3u8") || url.contains(":hls:") {
        return Err("Экспорт HLS пока недоступен; выберите прямой MP4 источник.".into());
    }
    let name = default_file_name
        .unwrap_or_else(|| "episode.mp4".into())
        .chars()
        .take(180)
        .map(|c| {
            if c.is_control() || "/\\?%*:|\"<>".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect::<String>();
    let handle = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("Сохранить серию")
            .set_file_name(name)
            .add_filter("Видео", &["mp4", "mkv", "ts"])
            .blocking_save_file()
    })
    .await
    .map_err(err)?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(err)?;
    let parent = path.parent().ok_or("Invalid selected folder")?;
    let temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Не удалось создать временный файл в выбранной папке")?;
    let _permit = state.0.slots.clone().acquire_owned().await.map_err(err)?;
    let mut req = state
        .0
        .client
        .get(url)
        .header("Accept-Encoding", "identity");
    if let Some(referer) = referer_header {
        crate::network::validate_url(&referer)?;
        req = req.header("Referer", referer);
    }
    let mut response = req
        .send()
        .await
        .map_err(|_| "Не удалось подключиться к источнику видео")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("Media HTTP {}", response.status()));
    }
    if response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("mpegurl"))
    {
        return Err("Экспорт HLS пока недоступен; выберите прямой MP4 источник.".into());
    }
    let total = response.content_length();
    if total.is_some_and(|n| n > MAX_BYTES) {
        return Err("Видео превышает лимит 16 ГиБ".into());
    }
    let mut file = tokio::fs::File::from_std(temp.reopen().map_err(err)?);
    let mut count = 0u64;
    let mut prefix = Vec::new();
    let mut last = Instant::now();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Загрузка прервана; исходный файл не изменён")?
    {
        if reject_text_media(&mut prefix, &chunk) {
            return Err(
                "Источник вернул HLS-плейлист или HTML, а не прямое видео. Выберите MP4 источник."
                    .into(),
            );
        }
        count = count
            .checked_add(chunk.len() as u64)
            .ok_or("Video too large")?;
        if count > MAX_BYTES {
            return Err("Видео превышает лимит 16 ГиБ".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|_| "Ошибка записи видео")?;
        if last.elapsed() > Duration::from_millis(500) {
            let _=app.emit("download:progress",json!({"filePath":path,"downloadedBytes":count,"totalBytes":total,"percent":total.filter(|n|*n>0).map(|n|(count as f64/n as f64*100.).min(99.)).unwrap_or(0.)}));
            last = Instant::now();
        }
    }
    if count == 0 || total.is_some_and(|n| n != count) {
        return Err("Источник вернул неполный файл".into());
    }
    file.sync_all().await.map_err(err)?;
    drop(file);
    temp.persist(&path)
        .map_err(|_| "Не удалось сохранить видео; исходный файл не изменён")?;
    let _ = app.emit(
        "download:progress",
        json!({"filePath":path,"downloadedBytes":count,"totalBytes":count,"percent":100}),
    );
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn offline_open(state: State<'_, Downloads>, id: String) -> Result<String, String> {
    let state = state.inner();
    let path = {
        let manifest = state.0.manifest.lock().map_err(err)?;
        if !manifest
            .jobs
            .values()
            .any(|j| j.status == "completed" && j.file_path == id)
        {
            return Err("Downloaded episode not found".into());
        }
        let path = owned(&state.0.root, &id)?;
        let canonical = path
            .canonicalize()
            .map_err(|_| "Downloaded episode file missing")?;
        if !canonical.starts_with(&state.0.root) {
            return Err("Offline path escaped storage".into());
        }
        canonical
    };
    crate::media_proxy::register_owned_file(path).await
}
