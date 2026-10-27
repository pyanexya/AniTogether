import { describe, it, expect } from 'vitest';
import { runtimeVersionLabels } from '../src/app/platform/runtime-info.js';

describe('native settings version labels', () => {
    it('uses host app and runtime versions without Electron remnants', () => {
        expect(runtimeVersionLabels({ anixartix: '0.1.0', runtime: 'tauri', tauri: '2', webview: 'Microsoft Edge WebView2' })).toEqual(['AnixArtix v0.1.0', 'Tauri 2', 'Microsoft Edge WebView2']);
    });
    it('does not render missing versions or invented browser versions', () => {
        expect(runtimeVersionLabels()).toEqual(['AnixArtix']);
        expect(runtimeVersionLabels({ anidesk: '0.1.0', runtime: 'tauri' })).toEqual(['AnixArtix v0.1.0', 'Tauri']);
    });
});
