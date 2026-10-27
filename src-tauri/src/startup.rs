//! Opt-in CI readiness evidence. Never records user data, errors, URLs, or credentials.
use serde::{Deserialize, Serialize};
use std::path::Path;
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartupStage {
    NativeStarted,
    BootstrapStarted,
    SettingsReady,
    AppLoaded,
    MountStarted,
    AppMounted,
    Failed,
}
fn write_stage(directory: &Path, stage: StartupStage) -> Result<(), String> {
    // Only the launching process can select the output directory, never IPC arguments.
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("Invalid smoke directory".into());
    }
    let evidence = serde_json::json!({"schema":1,"pid":std::process::id(),"stage":stage});
    std::fs::write(directory.join("startup-state.json"), evidence.to_string())
        .map_err(|_| "Unable to write smoke evidence".into())
}
pub fn report(stage: StartupStage) -> Result<(), String> {
    match std::env::var_os("ANIXARTIX_SMOKE_DIR") {
        Some(directory) => write_stage(Path::new(&directory), stage),
        None => Ok(()),
    }
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn startup_report(stage: StartupStage) -> Result<(), String> {
    report(stage)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evidence_is_bounded_and_nonsecret() {
        let dir = tempfile::tempdir().unwrap();
        write_stage(dir.path(), StartupStage::AppMounted).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("startup-state.json")).unwrap())
                .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"schema":1,"pid":std::process::id(),"stage":"app-mounted"})
        );
        assert!(serde_json::from_str::<StartupStage>("\"arbitrary-user-data\"").is_err());
        assert!(write_stage(Path::new("relative"), StartupStage::Failed).is_err());
        assert!(write_stage(&dir.path().join("absent"), StartupStage::Failed).is_err());
    }
}
