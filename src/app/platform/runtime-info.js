// Only display runtime details actually supplied by the native host.
export function runtimeVersionLabels(versions = {}) {
    const labels = [];
    const appVersion = versions.anixartix || versions.anidesk;
    labels.push(appVersion ? `AnixArtix v${appVersion}` : 'AnixArtix');
    if (versions.runtime === 'tauri') labels.push(versions.tauri ? `Tauri ${versions.tauri}` : 'Tauri');
    if (versions.webview) labels.push(versions.webview);
    return labels;
}
