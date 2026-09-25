// What the app is built from, with licenses checked against each source (model cards,
// LICENSE files, package metadata). Names are proper nouns, licenses SPDX ids: data, not
// UI copy. The Python runtime's packages are listed live by the sidecar; bundled
// binaries (uv, ffmpeg) join with the release notices (Session 10).

export type ComponentRole = 'model' | 'codec' | 'code' | 'watermark' | 'app';

export interface Component {
  name: string;
  role: ComponentRole;
  license: string;
}

export const COMPONENTS: Component[] = [
  { name: 'Irodori-TTS-v4.1-Small (Aratako)', role: 'model', license: 'MIT' },
  {
    name: 'Semantic-DACVAE-Japanese-32dim (Aratako)',
    role: 'codec',
    license: 'MIT',
  },
  { name: 'Irodori-TTS (Aratako)', role: 'code', license: 'MIT' },
  { name: 'SilentCipher (Sony)', role: 'watermark', license: 'MIT' },
  { name: 'Tauri', role: 'app', license: 'Apache-2.0 OR MIT' },
  { name: 'Next.js', role: 'app', license: 'MIT' },
  { name: 'React', role: 'app', license: 'MIT' },
  { name: 'i18next / react-i18next', role: 'app', license: 'MIT' },
  { name: 'Zustand', role: 'app', license: 'MIT' },
  { name: 'wavesurfer.js', role: 'app', license: 'BSD-3-Clause' },
];
