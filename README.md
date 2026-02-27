# Discord Voice Bot 🎙️

Discord VCでAIと音声会話するBot。

## 💡 会話のためのチューニング

本プロジェクトでは「AIと自然に話している感覚」を目指して、低コストで実施できる以下のチューニングを施しています。

### 🗣️ 待ち時間を感じさせない工夫
- **あいづち即再生**: STT完了と同時に「うん」「なるほどね」「へー」等をキャッシュから即再生。LLMの応答を待つ数秒間の沈黙を埋める
- **待ち緩和フレーズ**: LLM応答が5秒以内に来ない場合「ちょっと調べるね」を自動再生。ツール使用や長考時に「フリーズした？」と思わせない
- **文単位ストリーミング再生**: LLMの応答を全文待たずに、1文できた時点でTTS→再生を開始。体感レスポンスを大幅短縮

### 🎤 割り込み（Barge-in）を自然に
- **RMSベース音声検出**: タイマーではなく実際の音量レベルで判定。環境音やBotの出力エコーは自動フィルタ、人の声だけを検出
- **無限ループ防止**: 割り込み応答の音声が再びBotに拾われて無限ループになる問題を、再生中フラグで解決
- **「🔇 黙って」ボタン**: 音声割り込みが効かない時の物理的フェイルセーフ

### 🧹 ノイズ除去
- **Whisper誤認識フィルタ**: 無音区間でWhisperが出力する幻覚テキスト（`(音楽)`、`ご視聴ありがとうございました`等）を自動除去。誤反応を防止

### ⚡ レイテンシー最適化 & ローカル処理優先
外部APIコールは遅延とコストの両方に効く。可能な限りローカル処理に寄せています。

- **STT: Whisper.cppローカル常駐**: クラウドAPI不要。モデルはGPU(Metal)でメモリ常駐、推論~0.87秒。API課金ゼロ
- **TTS: VOICEVOXローカル**: クラウドTTS不要。48kHz出力でDiscord Opusに直結、リサンプリング不要。API課金ゼロ
- **TTS事前キャッシュ**: あいづち・待ちフレーズは起動時に全パターン生成済み。再生時のTTS待ちゼロ
- **唯一の外部API**: LLM（Claude）のみ。ここだけはローカルLLMでは品質が出ないため外部APIを採用

## パイプライン

```
🎤 Discord VC → 📝 Whisper.cpp STT → 🤖 OpenClaw LLM → 🔊 VOICEVOX TTS → 🔈 Discord VC
```

## アーキテクチャ

### STT (Speech-to-Text)
- **メイン**: Whisper.cpp server（ローカル常駐、無料、高精度日本語）
- **フォールバック**: OpenAI Whisper API（Whisper.cpp server未起動時）
- バッチ処理：無音検出（600ms）で発話区切り → WAV変換 → Whisper.cppに送信

### LLM
- **モデル**: Claude Sonnet 4-5（OpenClaw Gateway経由）
- ストリーミング応答 → 文単位でTTSにパイプライン

### TTS (Text-to-Speech)
- **VOICEVOX** ずんだもん（speaker ID: 3）
- speedScale=1.5, pauseLengthScale=0.25
- 48kHz出力（Discord Opusに合わせてリサンプリング不要、音質向上）

### 割り込み（Barge-in）
- **RMSベース音声検出**: Bot再生中にユーザーの音声レベル（RMS）が閾値を超え、一定時間続いたら割り込み
  - 環境音・エコーは音量が小さいのでフィルタされる
  - YouTube再生中でも人の声だけ検出可能
- **「🔇 黙って」ボタン**: テキストチャンネルに表示、押すと即停止
- 割り込み時はランダムな短い応答（「あ、了解、止めるね」等）を再生
- **無限ループ防止**: 割り込み応答の再生中は割り込み検出を無効化（`isPlayingBargeInResponse`フラグ）

### レイテンシー緩和
- **あいづち**: STT完了後、LLM応答を待つ間に「うん」「なるほどね」「へー」等を即再生（事前キャッシュ済み、TTS待ちゼロ）
- **待ちフレーズ**: LLM応答が5秒以内に来ない場合「ちょっと調べるね」「少し待ってね」を自動再生（検索・ツール使用時の間を緩和）

### ノイズフィルタ
- Whisperが誤認識する定型ノイズを自動除去
  - `(音楽)`, `[音楽]`, `ご視聴ありがとうございました`, `ん!` 等

## 必要なもの

- Node.js v22+
- [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) (whisper-server、ローカル常駐)
- [VOICEVOX](https://voicevox.hiroshiba.jp/) (ローカル起動、ポート50021)
- [OpenClaw](https://github.com/openclaw/openclaw) Gateway (ローカル起動)
- Discord Bot Token (Voice Bot用に別途作成)

## セットアップ

### 1. 依存パッケージ

```bash
npm install
```

### 2. Whisper.cpp server

```bash
# ビルド（初回のみ）
cd /path/to/whisper.cpp
cmake -B build -DWHISPER_METAL=ON
cmake --build build -j$(sysctl -n hw.ncpu)

# モデルダウンロード（初回のみ）
bash models/download-ggml-model.sh small

# pm2で常駐起動
pm2 start ./build/bin/whisper-server --name whisper-server -- \
  -m models/ggml-small.bin -l ja --port 8178 -t 4
```

### 3. 環境変数

`.env.example` をコピーして `.env` を作成：

```bash
cp .env.example .env
```

各値を設定：

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
OPENAI_API_KEY=your_openai_api_key          # Whisper APIフォールバック用（任意）
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789/v1
OPENCLAW_GATEWAY_TOKEN=your_openclaw_gateway_token
VOICEVOX_URL=http://127.0.0.1:50021
VOICE_CHANNEL_ID=your_voice_channel_id
TEXT_CHANNEL_ID=your_text_channel_id         # テキスト表示用（任意）
VOICEVOX_SPEAKER_ID=3
WHISPER_SERVER_URL=http://127.0.0.1:8178    # デフォルト値あり
```

### 4. 起動

```bash
# 直接起動
node src/index.js

# pm2でデーモン化（推奨） — ecosystem.config.cjsを使用
pm2 start ecosystem.config.cjs
pm2 save

# ⚠️ pm2 delete後は必ず ecosystem.config.cjs から起動すること
# 直接 pm2 start src/index.js すると cwd/.env が正しく読まれない場合がある
# pm2 restart voice-bot は問題なく使える
```

### 5. OS再起動後の自動起動（初回のみ）

```bash
pm2 startup
# ↑ 表示されたコマンドをコピペして実行（sudo付きのコマンドが出力される）
pm2 save
```

## 運用コマンド

```bash
pm2 status              # 状態確認
pm2 logs voice-bot      # Voice Botログ
pm2 logs whisper-server # Whisper serverログ
pm2 restart voice-bot   # 再起動
pm2 stop voice-bot      # 停止
```

## 設定パラメータ

| 項目 | 値 | 備考 |
|------|-----|------|
| STT | Whisper.cpp small | ローカルHTTP server常駐 |
| LLM | Claude Sonnet 4-5 | OpenClaw Gateway経由、ストリーミング |
| TTS | VOICEVOX ずんだもん(ID:3) | speedScale=1.5, pauseLengthScale=0.25 |
| 無音検出 | 500ms | 発話区切り判定 |
| 最小音声長 | 25パケット(~0.5秒) | 短すぎる音声を無視 |
| 割り込みRMS閾値 | 100 | Discord音声のRMS値基準 |
| 割り込み判定時間 | 600ms | 閾値超え音声がこの時間続いたら割り込み |

## レイテンシー（実測）

| 項目 | 時間 |
|------|------|
| STT (Whisper.cpp server) | ~1-4秒（発話長に依存） |
| LLM First chunk (Sonnet 4-5) | ~3-5秒 |
| TTS (VOICEVOX) | ~0.3-1秒 |
| あいづち再生 | 即時（キャッシュ済み） |
| 待ちフレーズ閾値 | 5秒（LLM応答なし時） |
| **トータル（話し終わり → 音声再生開始）** | **~5-8秒**（あいづちで体感緩和） |

## 構成

```
src/
├── index.js  # メイン: Discord接続、音声受信、割り込み、パイプライン制御
├── stt.js    # Whisper.cpp server STT + Whisper API フォールバック
├── llm.js    # OpenClaw Gateway LLM (ストリーミング応答)
└── tts.js    # VOICEVOX TTS
```

## ライセンス

MIT License — 詳細は [LICENSE](./LICENSE) を参照。

## 依存サービス

```
pm2 list で確認:
┌──────────────────┬────────┐
│ voice-bot        │ online │  Discord Voice Bot本体
│ whisper-server   │ online │  Whisper.cpp STT server (port 8178)
└──────────────────┴────────┘

別途起動が必要:
- VOICEVOX Engine (port 50021)
- OpenClaw Gateway (port 18789)
```
