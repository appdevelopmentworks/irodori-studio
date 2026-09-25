# Third-party notices

irodori-studio is released under the [MIT License](LICENSE). It builds on the works listed below. Licenses were checked against each source (model cards, LICENSE files, package metadata); the texts of the MIT and BSD licenses follow at the end.

> **Release builds:** the exact FFmpeg and uv builds bundled with each installer, and generated lists of every npm package and Rust crate compiled into the app, are added to this file when release packaging is finished (`docs/session-plan.md`, Session 10). The complete list of Python packages the app installs, with their licenses, is shown in the app under **Settings → About**.

## Models and inference code

| Component | Role in the app | License | Source |
| --- | --- | --- | --- |
| Irodori-TTS (code) — Copyright (c) 2026 Aratako | Speech synthesis. Installed builds include its source at a pinned commit, unmodified. | MIT | [github.com/Aratako/Irodori-TTS](https://github.com/Aratako/Irodori-TTS) |
| Irodori-TTS-v4.1-Small (model weights) — Aratako | The speech model, downloaded from Hugging Face during setup | MIT, with the ethical restrictions of its model card (see the [README](README.md#ethics-and-terms)) | [huggingface.co/Aratako/Irodori-TTS-v4.1-Small](https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small) |
| Semantic-DACVAE-Japanese-32dim (codec weights) — Aratako | The audio codec, downloaded during setup | MIT (model card). It is derived from [facebook/dacvae-watermarked](https://huggingface.co/facebook/dacvae-watermarked), whose model card lists `apache-2.0` in its metadata and refers to the SAM License in its text. | [huggingface.co/Aratako/Semantic-DACVAE-Japanese-32dim](https://huggingface.co/Aratako/Semantic-DACVAE-Japanese-32dim) |
| DACVAE (code) — Meta Platforms, Inc. and affiliates | The codec library, installed during setup | Apache-2.0 | [github.com/facebookresearch/dacvae](https://github.com/facebookresearch/dacvae) |
| SilentCipher — Copyright (c) 2024 Sony Research Inc. | Audio watermarking (code installed during setup from the SesameAILabs fork that Irodori-TTS pins; model files from Hugging Face `sony/silentcipher`) | MIT | [github.com/sony/silentcipher](https://github.com/sony/silentcipher) |

## Japanese text analysis (installed during setup)

| Component | Role in the app | License | Source |
| --- | --- | --- | --- |
| pyopenjtalk-plus (pyopenjtalk — Copyright (c) 2018 Ryuichi Yamamoto) | Reading preview and mora counts for the user dictionary and length estimates | MIT | [github.com/tsukumijima/pyopenjtalk-plus](https://github.com/tsukumijima/pyopenjtalk-plus) |
| Open JTalk and its dictionary (included in pyopenjtalk-plus) | Japanese text analysis | Modified BSD | [open-jtalk.sourceforge.net](https://open-jtalk.sourceforge.net/) |
| SudachiPy and SudachiDict (core) — Works Applications | Reading disambiguation used by pyopenjtalk-plus | Apache-2.0 | [github.com/WorksApplications/sudachi.rs](https://github.com/WorksApplications/sudachi.rs), [github.com/WorksApplications/SudachiDict](https://github.com/WorksApplications/SudachiDict) |

## Python runtime (installed during setup, not bundled)

During setup, uv downloads these into the storage folder from their original sources (python-build-standalone, PyPI, download.pytorch.org). The main components:

| Component | License |
| --- | --- |
| CPython (python-build-standalone distribution) | PSF License; the distribution also contains libraries under their own licenses (for example OpenSSL) |
| PyTorch, torchaudio, torchcodec | BSD-3-Clause; the CUDA builds include NVIDIA CUDA libraries under NVIDIA's license terms |
| FastAPI | MIT |
| uvicorn, NumPy, soundfile | BSD-3-Clause |
| huggingface_hub, safetensors, transformers, peft, accelerate | Apache-2.0 |

**Settings → About** lists every installed package, with its version and the license its metadata names.

## The desktop app (compiled into the installer)

### Web frontend

| Package | License | Copyright |
| --- | --- | --- |
| Next.js | MIT | Copyright (c) 2025 Vercel, Inc. |
| React, React DOM | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| i18next | MIT | Copyright (c) 2011-present i18next |
| react-i18next | MIT | Copyright (c) 2015-present i18next |
| Zustand | MIT | Copyright (c) 2019 Paul Henschel |
| wavesurfer.js | BSD-3-Clause | Copyright (c) 2012-2023, katspaugh and contributors |
| Tailwind CSS | MIT | Copyright (c) Tailwind Labs, Inc. |
| @tauri-apps/api, @tauri-apps/plugin-dialog | Apache-2.0 OR MIT | Copyright (c) 2017 - Present Tauri Apps Contributors |

### Rust

[Tauri](https://tauri.app/) (Apache-2.0 OR MIT) and 265 crates on Windows. Their licenses: MIT and/or Apache-2.0 (most), Unicode-3.0 (the ICU crates), MPL-2.0 (`cssparser`, `cssparser-macros`, `dtoa-short`, `selectors`, `option-ext`), BSD-3-Clause (the `brotli` family), Zlib, Unlicense and CC0 alternatives. The MPL-2.0 crates are used unmodified; their source code is available on [crates.io](https://crates.io/).

## Bundled programs (release builds)

| Program | Role in the app | License | Source |
| --- | --- | --- | --- |
| uv — Astral Software Inc. | Installs Python and the runtime during setup | MIT OR Apache-2.0 | [github.com/astral-sh/uv](https://github.com/astral-sh/uv) |
| FFmpeg | Audio conversion and post-processing | LGPL-2.1-or-later (a build without GPL components). The build used and where to get its source are recorded here for each release. | [ffmpeg.org](https://ffmpeg.org/) |

## Names

OpenAI and VOICEVOX are named only to describe API compatibility. irodori-studio is not affiliated with or endorsed by OpenAI, the VOICEVOX project, or the authors of Irodori-TTS.

---

## License texts

### MIT License

Applies to the MIT-licensed components above, with these copyright notices:

- Copyright (c) 2026 Aratako (Irodori-TTS)
- Copyright (c) 2024 Sony Research Inc. (SilentCipher)
- Copyright (c) 2018 Ryuichi Yamamoto (pyopenjtalk)
- Copyright (c) 2025 Vercel, Inc. (Next.js)
- Copyright (c) Meta Platforms, Inc. and affiliates. (React, React DOM)
- Copyright (c) 2011-present i18next (i18next); Copyright (c) 2015-present i18next (react-i18next)
- Copyright (c) 2019 Paul Henschel (Zustand)
- Copyright (c) Tailwind Labs, Inc. (Tailwind CSS)
- Copyright (c) 2017 - Present Tauri Apps Contributors (Tauri, under the MIT option)

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### BSD 3-Clause License (wavesurfer.js)

```text
Copyright (c) 2012-2023, katspaugh and contributors
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Apache License 2.0

The Apache-2.0 components above are licensed under the Apache License, Version 2.0: <https://www.apache.org/licenses/LICENSE-2.0>.
