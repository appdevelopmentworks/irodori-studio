#!/usr/bin/env node
// Runs before `tauri build` bundles the app (tauri.conf.json > build.beforeBundleCommand):
// fails when resources/ was not staged for this platform, so an installer never ships
// without its sidecar, uv or ffmpeg. Stage with scripts/stage-runtime.ps1 (Windows) or
// scripts/stage-runtime.sh (macOS).
//
// Usage: node scripts/check-staged.mjs

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = join(ROOT, 'resources');
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

const required = [
  'sidecar/pyproject.toml',
  'sidecar/uv.lock',
  'sidecar/.python-version',
  'sidecar/models.json',
  'sidecar/upstream.json',
  'sidecar/app/main.py',
  'sidecar/irodori_tts/__init__.py',
  'sidecar/irodori_tts/LICENSE',
  `uv/${exe('uv')}`,
  `ffmpeg/${exe('ffmpeg')}`,
  'ffmpeg/LICENSE.txt',
  'ffmpeg/LICENSE-lame.txt',
  'ffmpeg/LICENSE-opus.txt',
  'ffmpeg/BUILD.txt',
];

const missing = required.filter((path) => {
  const full = join(RESOURCES, path);
  return !existsSync(full) || statSync(full).size === 0;
});

if (missing.length > 0) {
  console.error('check-staged: resources/ is not staged for this platform. Missing:');
  for (const path of missing) console.error(`  resources/${path}`);
  console.error(
    process.platform === 'win32'
      ? 'Run: powershell -ExecutionPolicy Bypass -File scripts\\stage-runtime.ps1'
      : 'Run: scripts/stage-runtime.sh',
  );
  process.exit(1);
}
console.log(`check-staged: OK — ${required.length} required files in resources/`);
