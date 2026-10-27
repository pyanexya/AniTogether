import svelte from 'rollup-plugin-svelte';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import livereload from 'rollup-plugin-livereload';
import terser from '@rollup/plugin-terser';
import css from 'rollup-plugin-css-only';
import json from '@rollup/plugin-json';
import { spawn } from 'child_process';
import { string } from 'rollup-plugin-string';
import fs from 'fs';
import path from 'path';
import os from 'os';

const production = !process.env.ROLLUP_WATCH;
const fastBuild = process.env.FAST_BUILD === 'true';

function loadEnv() {
    const envPath = path.resolve(__dirname, '.env');
    const env = { ...process.env };
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const idx = trimmed.indexOf('=');
            if (idx > 0) {
                const key = trimmed.slice(0, idx).trim();
                let val = trimmed.slice(idx + 1).trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                if (!env[key]) {
                    env[key] = val;
                }
            }
        }
    }
    return env;
}

const envVars = loadEnv();

// Only the public client ID is embedded. OAuth secrets stay in the main process.
function envPlugin() {
    return {
        name: 'env-replace',
        transform(code, id) {
            if (!id.includes('node_modules')) {
                let replaced = code
                    .replace(/__ENV_SHIKIMORI_CLIENT_ID__/g, JSON.stringify(envVars.SHIKIMORI_CLIENT_ID || ''))
                    .replace(/__ENV_SHIKIMORI_CLIENT_SECRET__/g, JSON.stringify(''));
                return { code: replaced, map: null };
            }
        }
    };
}

function serve() {
    let server;

    function toExit() {
        if (server) server.kill(0);
    }

    return {
        writeBundle() {
            if (server) return;
            server = spawn('npm', ['run', 'start', '--', '--dev'], {
                stdio: ['ignore', 'inherit', 'inherit'],
                shell: true
            });

            process.on('SIGTERM', toExit);
            process.on('exit', toExit);
        }
    };
}

export default {
    input: 'src/app/app.js',
    output: {
        sourcemap: !production,
        format: 'es',
        dir: 'public/build',
        entryFileNames: 'bundle.js',
        chunkFileNames: 'chunks/[name]-[hash].js'
    },
    plugins: [
        { name: 'clean-generated-build', buildStart() { if (production) fs.rmSync(path.resolve(__dirname, 'public/build'), { recursive: true, force: true }); } },
        envPlugin(),
        svelte({
            compilerOptions: {
                dev: !production
            },
            onwarn: (warning, handler) => {
                if (warning.code.startsWith("a11y-")) return;
                handler(warning);
            }
        }),
        resolve({
            browser: true,
            exportConditions: ['svelte'],
            dedupe: ['svelte']
        }),
        string({
            include: '**/*.svg',
        }),
        css({ output: 'bundle.css' }),
        json(),
        commonjs(),
        !production && serve(),
        !production && livereload('public'),
        production && !fastBuild && terser({
            maxWorkers: Math.max(1, Math.min(2, Math.floor(os.cpus().length / 2)))
        }),
    ],
    watch: {
        clearScreen: false
    }
};