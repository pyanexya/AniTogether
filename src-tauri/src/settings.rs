use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
};

pub struct Settings {
    path: PathBuf,
    values: Mutex<Value>,
}
impl Settings {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        let mut values: Value =
            serde_json::from_str(include_str!("../../src/shared/defaultSettings.json"))
                .map_err(|e| e.to_string())?;
        if path.exists() {
            let file = fs::File::open(&path).map_err(|e| e.to_string())?;
            if file.metadata().map_err(|e| e.to_string())?.len() > 1_048_576 {
                return Err("Settings file too large".into());
            }
            let mut bytes = Vec::new();
            file.take(1_048_577)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 1_048_576 {
                return Err("Settings file too large".into());
            }
            let saved: Value = serde_json::from_slice(&bytes)
                .map_err(|_| "Settings file is corrupt; preserved for recovery".to_string())?;
            let map = saved
                .as_object()
                .ok_or("Settings must contain an object; preserved for recovery")?;
            values.as_object_mut().unwrap().extend(map.clone());
        }
        Ok(Self {
            path,
            values: Mutex::new(values),
        })
    }
    pub fn all(&self) -> Result<Value, String> {
        Ok(self
            .values
            .lock()
            .map_err(|_| "Settings lock failed")?
            .clone())
    }
    pub fn get(&self, key: &str) -> Result<Value, String> {
        Ok(self.all()?.get(key).cloned().unwrap_or(Value::Null))
    }
    pub fn set(&self, key: String, value: Value) -> Result<(), String> {
        if ["__proto__", "prototype", "constructor"].contains(&key.as_str())
            || key.is_empty()
            || key.len() > 128
            || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err("Invalid settings key".into());
        }
        if serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > 65536 {
            return Err("Setting too large".into());
        }
        let mut lock = self.values.lock().map_err(|_| "Settings lock failed")?;
        let mut next = lock.clone();
        next[&key] = value;
        let encoded = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
        if encoded.len() > 1_048_576 {
            return Err("Settings file size limit reached".into());
        }
        let parent = self.path.parent().ok_or("Invalid settings path")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temp.write_all(&encoded).map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(&self.path).map_err(|e| e.to_string())?;
        *lock = next;
        Ok(())
    }
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn settings_get_all(state: tauri::State<'_, Settings>) -> Result<Value, String> {
    state.all()
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn settings_get(state: tauri::State<'_, Settings>, key: String) -> Result<Value, String> {
    state.get(&key)
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn settings_set(
    state: tauri::State<'_, Settings>,
    key: String,
    value: Value,
) -> Result<(), String> {
    state.set(key, value)
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn proxy_toggle(
    state: tauri::State<'_, Settings>,
    enabled: Option<bool>,
) -> Result<bool, String> {
    let enabled = enabled.unwrap_or(!state.get("EnableCdnProxy")?.as_bool().unwrap_or(false));
    if enabled {
        return Err("CDN-прокси пока недоступен в Tauri-версии".into());
    }
    state.set("EnableCdnProxy".into(), json!(false))?;
    Ok(enabled)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_are_atomic_and_persistent() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("settings.json");
        let s = Settings::new(p.clone()).unwrap();
        s.set("PlayerLastVolume".into(), json!(0.4)).unwrap();
        s.set("Theme".into(), json!("dark")).unwrap();
        assert_eq!(
            Settings::new(p).unwrap().get("PlayerLastVolume").unwrap(),
            json!(0.4)
        );
    }
    #[test]
    fn rejects_invalid_and_large_settings() {
        let d = tempfile::tempdir().unwrap();
        let s = Settings::new(d.path().join("s.json")).unwrap();
        assert!(s.set("../secret".into(), json!(true)).is_err());
        assert!(s.set("x".into(), json!("x".repeat(70000))).is_err());
    }
    #[test]
    fn rejects_aggregate_overflow_without_losing_saved_values() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("s.json");
        let settings = Settings::new(path.clone()).unwrap();
        for n in 0..16 {
            settings
                .set(format!("key{n}"), json!("x".repeat(63000)))
                .unwrap();
        }
        assert!(settings
            .set("overflow".into(), json!("x".repeat(63000)))
            .is_err());
        assert!(settings.get("overflow").unwrap().is_null());
        assert!(Settings::new(path).is_ok());
    }
    #[test]
    fn preserves_corrupt_settings() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s.json");
        fs::write(&p, "broken").unwrap();
        assert!(Settings::new(p.clone()).is_err());
        assert_eq!(fs::read_to_string(p).unwrap(), "broken");
    }
}
