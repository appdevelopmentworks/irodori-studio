# irodori-studio

Aratako 氏の日本語音声合成モデル [Irodori-TTS](https://github.com/Aratako/Irodori-TTS) を使う、非公式のデスクトップアプリです。Windows（NVIDIA GPU または CPU）と macOS（Apple Silicon）に対応しています。

[English README](README.md)

> **状況:** v0.1.0。機能はそろっており、公開前のテスト中です。インストーラーは [Releases](https://github.com/appdevelopmentworks/irodori-studio/releases) で公開します。Windows は Windows 11 と RTX 50 シリーズで動作を確認済みです。macOS 版は実機での確認がまだです。
>
> 「irodori-studio」は仮の名前です。Irodori-TTS の**公式アプリではありません**。

## 主な機能

- **かんたん生成** — 公式デモの全パラメーター、キャプション（声・感情・話し方を日本語で指定）、絵文字によるスタイル指定、参照音声（複数クリップ）、話者埋め込み（`.speaker.safetensors`）、LoRA アダプター、複数候補の聴き比べ、シードの固定・ランダム。
- **ボイススタジオ** — 声のライブラリ。キャプションから声を設計、参照音声の取り込み・録音（本人の同意を記録）、クリップのトリム・分割、話者埋め込み、声ごとの既定値。`.irovoice` パッケージで声を共有できます。
- **ナレーション** — 長い文章（貼り付け、`.txt` / `.md`、SRT / WebVTT）をチャンクに分け、同じ声で読み上げ。ユーザー辞書と読みのプレビュー、チャンク単位の作り直し、SRT / WebVTT 字幕つきの書き出し。
- **台本** — 「話者：セリフ」形式のテキストや CSV / TSV の表から複数話者の台本を作成。話者ごとの声、行ごとのテイク、ゲームエンジン向けの行別ファイル、結合したドラマ、字幕、表の書き出し。
- **ライブラリ・履歴** — すべての生成を設定ごと保存。検索・絞り込み、同じ条件で再生成、設定の再利用、ファイル名テンプレートによる一括書き出し。パラメータープリセット、プロジェクト（`.iroproj`）。
- **出力** — WAV・MP3・M4A（AAC）・FLAC・Opus、48 / 44.1 kHz、ラウドネス（−14 / −16 / −23 LUFS）、話速、音量。
- **API サーバー** — ほかのアプリ向けの OpenAI 互換（`/v1/audio/speech`）・VOICEVOX 互換 API。既定ではこのパソコンのみ、API キーを設定すれば LAN にも公開できます。
- **設定** — 保存先フォルダー（あとから移動可能）、デバイスと精度、GPU とメモリのモニター、電子透かし、アップデートの通知、ログ、ライセンス。
- 画面は日本語・英語・中国語（簡体字）・ドイツ語。**モデルが読み上げられるのは日本語のテキストのみ**です。

## 動作環境

|  | Windows | macOS |
| --- | --- | --- |
| OS | Windows 10 / 11（64 ビット） | macOS 14 以降 |
| プロセッサー / GPU | Volta 世代以降、VRAM 6 GB 以上の NVIDIA GPU（8 GB 以上を推奨。6〜8 GB では自動で bf16 を使います）。使える GPU がない場合は **CPU モード**で動作します（大幅に遅くなります）。 | Apple Silicon **M2 以降**（M1 は「動作保証外」の警告を出して起動します） |
| メモリ | — | 16 GB 推奨（8 GB でも動作しますが遅くなります） |
| ディスク | 約 15 GB（実行環境 約 8 GB＋モデル 約 4 GB）＋履歴・書き出し | 約 8 GB＋履歴・書き出し |
| ネットワーク | 初回セットアップ時に必要。以降はオフラインで動作します | 同左 |

NVIDIA GPU を使う場合は、アプリが入れる CUDA 12.8 に合わせて新しいドライバー（R570 以降）をおすすめします。

## インストール

### Windows

1. [Releases](https://github.com/appdevelopmentworks/irodori-studio/releases) から `irodori-studio_<バージョン>_x64-setup.exe` をダウンロードします。
2. 実行します。インストーラーはコード署名していないため、「Windows によって PC が保護されました」と表示されることがあります。その場合は **詳細情報** → **実行** を押してください。
3. スタートメニューから **irodori-studio** を起動します。

### macOS（Apple Silicon）

1. [Releases](https://github.com/appdevelopmentworks/irodori-studio/releases) から `irodori-studio_<バージョン>_aarch64.dmg` をダウンロードします。
2. 開いて **irodori-studio** を **アプリケーション** フォルダーにドラッグします。
3. このアプリはアドホック署名のみで、Apple の公証を受けていません。初めて起動する前に、ターミナルで次のコマンドを実行してください（実行しないと「壊れているため開けません」「開けません」と表示されます）。

   ```bash
   xattr -dr com.apple.quarantine "/Applications/irodori-studio.app"
   ```

4. アプリを起動します。初めて録音するときに、マイクへのアクセスの許可を求められます。

### 初回セットアップ

セットアップ画面が次の順に案内します。

1. **言語**と**利用条件**（モデルの倫理上の制限を含みます。[下記](#倫理上の制限と利用条件)を参照）。
2. **動作環境の確認:** GPU（CUDA または Apple Silicon）か CPU モードか、精度。CPU モードを自分で選ぶこともできます。
3. **保存先フォルダー:** 実行環境・モデル・声・履歴など、すべてをここに置きます（約 15 GB）。
4. **インストール:** アプリ専用の Python、必要なパッケージ、お使いの環境に合った PyTorch（CUDA 12.8 版・CPU 版・macOS 版）、モデル（約 3.6 GB、Hugging Face から）をダウンロードし、GPU の動作を確認します。時間がかかることがありますが、途中で止まっても続きから再開します。

完了するとモデルが読み込まれ、サンプル文が入った「かんたん生成」画面が開きます。システム全体には何もインストールしません。アプリ本体と保存先フォルダーがすべてです。

## 使い方

- **かんたん生成:** 日本語のテキスト（2,000 文字まで）を入力し、必要ならキャプションと声を選んで **生成**（`Ctrl` / `⌘` + `Enter`）。候補を聴き比べて採用し、保存します。生成したものはすべて「ライブラリ・履歴」に残ります。
- **ボイススタジオ:** キャプション、参照音声（雑音の少ない声が 30 秒ほどあると最適）、話者埋め込みのいずれかから声を一度作り、既定値を決めておけば、ほかの画面でいつでも選べます。
- **ナレーション:** 原稿を貼り付けるか開き、チャンクと読みを確認して生成。気になるチャンクだけ作り直し、音声と字幕を書き出します。
- **台本:** 「名前：セリフ」のテキストを貼り付けるか CSV / TSV を開き、話者ごとに声を割り当てて生成。行別ファイルやドラマ全体を書き出します。
- **ショートカット:** `Ctrl` / `⌘` + `1`〜`7` で画面の切り替え、`Ctrl` / `⌘` + `,` で設定を開きます。

## API サーバー

アプリの起動中は、ほかのアプリからこのアプリの声を使えます。「API サーバー」画面で有効にしてください（既定は無効、`http://127.0.0.1:50221`）。リクエストはアプリの画面と同じ順番待ちで 1 件ずつ処理されます。

**OpenAI 互換** — たとえば OpenAI の Python SDK では次のように呼び出せます。

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:50221/v1", api_key="unused")

with client.audio.speech.with_streaming_response.create(
    model="irodori-tts",
    voice="none",  # ライブラリの声の名前または ID
    input="こんにちは。今日はいい天気ですね。",
    response_format="wav",
    extra_body={"irodori": {"seed": 42}},
) as response:
    response.stream_to_file("speech.wav")
```

形式は `wav`・`mp3`・`flac`・`opus`・`aac`・`pcm`、話速は `speed`（0.25〜4）。長い文章は自動で分割し、`stream_format: "sse"` でチャンクごとに受け取れます。キャプションやサンプリングのパラメーターは `irodori` 拡張フィールドで指定します。

**VOICEVOX 互換** — VOICEVOX のエンジン API に対応したアプリで、エンジンの URL に `http://127.0.0.1:50221` を指定します。ライブラリの声が「話者」に、声の設定そのままの「ノーマル」とスタイルプリセットが「スタイル」になります。話速・音量・前後の無音・サンプリングレート・ステレオは反映され、音高・抑揚・間の長さ・アクセントの編集は反映されません。

ほかの端末から使うときは「LAN に公開」を選びます。この場合は API キーが必須になり（`Authorization: Bearer <キー>` または `X-API-Key: <キー>`）、ファイアウォールで接続の許可を求められることがあります。API の詳細は [`docs/api-spec.md`](docs/api-spec.md)（英語）を参照してください。

## データの保存場所

- **保存先フォルダー**（セットアップで選択。「設定」→「保存先」に表示）: 実行環境（Python・PyTorch）、モデル、データベース（声・履歴・ナレーション・台本・プリセット）、音声、プロジェクト、ログ。既定の場所は次のとおりです。
  - Windows: `%LOCALAPPDATA%\com.aileap.irodori-studio\data`
  - macOS: `~/Library/Application Support/com.aileap.irodori-studio/data`

  別のフォルダーやドライブに移すときは、「設定」→「保存先」→「保存先フォルダーの移動」を使ってください。コピーして確認してから切り替え、元のフォルダーは削除するまで残ります。フォルダーを手作業で移動しないでください。
- **設定ファイル:** `%APPDATA%\com.aileap.irodori-studio\settings.json`（Windows）、`~/Library/Application Support/com.aileap.irodori-studio/settings.json`（macOS）。

### アンインストール

- **Windows:** 設定 → アプリ → irodori-studio → アンインストール。
- **macOS:** アプリを終了し、「アプリケーション」からゴミ箱に移します。

すべてを消すには、上記の保存先フォルダーと設定ファイルも削除してください。アプリを閉じると裏で動くエンジンも必ず終了し、プロセスは残りません。

## 困ったときは

| 症状 | 対処 |
| --- | --- |
| セットアップがエラーで止まる | 接続と空き容量を確認して **再試行** を押してください。続きから再開します。詳細はログ（**ログを表示**）にあります。 |
| 「CPU モード」と表示される | 使える NVIDIA GPU が見つかりませんでした（GPU がない、Volta より古い、VRAM が 6 GB 未満）。CPU モードでも動作しますが遅くなります。GPU を追加したりドライバーを更新したりしたあとは、アプリを再起動して「設定」→「モデルとデバイス」の **インストールを修復** を実行してください。環境を調べ直し、GPU 版の PyTorch を入れます（CPU モードを自分で選んだ場合を除く）。 |
| 「メモリが足りません」 | 候補数を減らすか、テキストを短くしてください。「設定」→「モデルとデバイス」で **bf16** を試す方法もあります（Ampere 世代以降の GPU）。 |
| 起動せずエラー画面になる | **再試行** で直らなければ **インストールを修復**（パッケージとモデルファイルを確認。インターネット接続が必要）を実行し、ログを確認してください。 |
| 「GPU でエラーが起きた」と赤い帯が出る | **エンジンを再起動** を押してください。 |
| 読み間違える | ナレーションや台本のユーザー辞書に登録し、読みのプレビューで確認してください。 |
| API サーバーが起動しない | ポートが使用中です。「API サーバー」画面で別のポートを指定してください。 |
| ほかの端末から API サーバーにつながらない | 「LAN に公開」を選んで API キーを設定し、ファイアウォールで接続を許可してください。 |
| ディスクがいっぱい | 空きを増やすか、保存先フォルダーを別のドライブに移してください（「設定」→「保存先」）。 |
| macOS で「壊れている」と表示される | [インストール](#macosapple-silicon) の `xattr` コマンドを実行してください。 |
| セキュリティソフトがインストーラーやアプリをブロック・隔離する | インストーラーとアプリにはコード署名がないため、挙動を監視する保護機能に検知されることがあります（特にインストール中・アンインストール中）。このプロジェクトの [Releases](https://github.com/appdevelopmentworks/irodori-studio/releases) ページから入手したインストーラーであれば、セキュリティソフトの隔離から復元し、誤検知としてメーカーに報告してください。 |

ログは「設定」→「ログ」（エンジンは `sidecar.log`、セットアップは `setup.log`）と、保存先フォルダーの `logs` にあります。[不具合を報告する](https://github.com/appdevelopmentworks/irodori-studio/issues)ときは、ログを添えてください。

## 倫理上の制限と利用条件

Irodori-TTS は MIT ライセンスで公開されており、あわせて[モデルカード](https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small)で次の**倫理上の制限**が定められています。セットアップ時に同意していただきます。

1. **なりすましの禁止:** 本人の明示的な同意なく、特定の人物（声優、著名人、公人など）の声を複製したり、なりすましに使ったりしないでください。
2. **誤情報の禁止:** ディープフェイクや、人を欺く・誤情報を広めることを目的とした音声を作らないでください。
3. **声の生成に関する注意:** 参照音声を使わずテキストやキャプションだけで生成した声が、偶然実在の人物の声に似ることがあります。
4. **免責:** 開発者は悪用について一切の責任を負いません。生成物の利用が法令に沿うようにする責任は利用者にあります。

アプリでは、実在の人の録音から作る声には同意の確認が必要で、その記録は声とともに保存され、声のパッケージにも含まれます。生成した音声には、AI で生成したことを確かめられるように、聞き取れない**電子透かし**（SilentCipher）を既定で埋め込みます。設定で電子透かしを切った音声を公開するときは、AI で生成したことを明記してください。

## プライバシー

このアプリは利用状況を送信しません（テレメトリーなし）。インターネットに接続するのは次の場合だけです。

- セットアップ時とインストールの修復時の、実行環境とモデルのダウンロード（uv による Python、PyPI、download.pytorch.org、Hugging Face）
- 起動時の、GitHub Releases での新しいバージョンの確認（設定で無効にできます）
- API サーバーを有効にしたときの、ほかのアプリからの接続の受け付け（LAN に公開しない限りこのパソコンのみ）

## ソースからのビルド

必要なもの: [Node.js](https://nodejs.org/) 24、[Rust](https://rustup.rs/)（stable）、[uv](https://docs.astral.sh/uv/) 0.12.5、Git、お使いの OS 向けの [Tauri の前提ソフト](https://v2.tauri.app/start/prerequisites/)。開発時に WAV 以外の形式を扱うには、`PATH` 上の `ffmpeg` か、[インストーラー](#インストーラー)用に配置した ffmpeg が必要です。

```bash
git clone --recurse-submodules https://github.com/appdevelopmentworks/irodori-studio.git
cd irodori-studio
npm install
npm run tauri dev
```

初回起動では、インストール版と同じセットアップ画面が開きます。チェック用のコマンド:

```bash
npm run lint
npm run check:i18n
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --manifest-path src-tauri/Cargo.toml
cd sidecar
uv sync
uv run ruff check .
uv run pytest -m "not gpu"
```

開発に参加する方は [`CLAUDE.md`](CLAUDE.md) と [`docs/`](docs/) の資料（要件定義書以外は英語）から読み始めてください。

### インストーラー

インストーラーには、サイドカー（固定したバージョンの `irodori_tts` を含む）、uv、音声専用の LGPL 版 ffmpeg を同梱します。先にこれらを `resources/` に配置してから、ビルドします。配置スクリプトは uv と ffmpeg をダウンロードし、チェックサムを確認します。

```bash
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File scripts\stage-runtime.ps1
# macOS
scripts/stage-runtime.sh

npm run tauri build
```

インストーラーは `src-tauri/target/release/bundle/`（Windows は `nsis/`、macOS は `dmg/`）に出力されます。ビルドは同梱の前に `resources/licenses/rust-crates.md`（アプリに含まれる Rust クレートとそのライセンスの一覧）を生成し、`resources/` が未配置なら止まります。`v*` タグを push すると、GitHub Actions（[`release.yml`](.github/workflows/release.yml)）が両プラットフォームで同じ手順を実行し、インストーラーを下書きのリリースに添付します。

ffmpeg（FFmpeg に LAME と Opus だけを静的リンクしたもの）は、[`scripts/build-ffmpeg.sh`](scripts/build-ffmpeg.sh) を使って GitHub Actions（[`ffmpeg.yml`](.github/workflows/ffmpeg.yml)。バージョンを上げるときに手動で実行）でビルドし、元のソースとともにプレリリースとして公開しています。配置スクリプトは、そのリリースとチェックサムを固定して使います。

## ライセンス

- このアプリ: [MIT](LICENSE)
- Irodori-TTS（コードとモデルの重み）と、Aratako 氏の Semantic-DACVAE-Japanese-32dim コーデック: MIT。SilentCipher（Sony）: MIT。
- そのほかの構成要素: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。実行環境の Python パッケージとそのライセンスの一覧は、アプリの「設定」→「情報」で確認できます。

## 謝辞

- Irodori-TTS とそのモデル、Semantic-DACVAE-Japanese コーデック、そしてこのアプリの API のお手本にした Irodori-TTS-Server を公開している [Aratako](https://huggingface.co/Aratako) 氏
- [SilentCipher](https://github.com/sony/silentcipher)（Sony）、[DACVAE](https://github.com/facebookresearch/dacvae)（Meta）、[pyopenjtalk-plus](https://github.com/tsukumijima/pyopenjtalk-plus) と Open JTalk、[Sudachi](https://github.com/WorksApplications/sudachi.rs)、[Tauri](https://tauri.app/)、[uv](https://github.com/astral-sh/uv)
- OpenAI と VOICEVOX の名前は、API の互換性を説明するためだけに使っています。本プロジェクトはそれらの提供元とも、Irodori-TTS の作者とも関係がなく、承認を受けたものでもありません。
