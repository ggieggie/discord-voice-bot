import 'dotenv/config';
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStreamingSTT } from './stt.js';
import { generateResponseStream } from './llm.js';
import { synthesizeSpeech } from './tts.js';
import OpusScript from 'opusscript';

const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const TEXT_CHANNEL_ID = process.env.TEXT_CHANNEL_ID || '';
const TMP_DIR = join(tmpdir(), 'discord-voice-bot');
let textChannel = null;
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const player = createAudioPlayer();
let currentConnection = null;

// Per-user state
const userRecordings = new Map();

// Audio playback queue
const playbackQueue = [];
let isPlaying = false;
let isBotSpeaking = false;
let currentResponseAborted = false;

// Config
const SILENCE_DURATION_MS = 500;
const MIN_AUDIO_PACKETS = 25; // ~0.5s worth of opus packets (20ms each)
let isProcessing = false; // LLM処理中フラグ（同時実行防止）
let isPlayingBargeInResponse = false; // バージイン応答再生中（再検出防止）

// RMS-based barge-in config
const BARGE_IN_RMS_THRESHOLD = 100;   // 音量閾値（Discord音声は小さいので低めに設定）
const BARGE_IN_DURATION_MS = 600;     // この時間以上、閾値超え音声が続いたら割り込み

// あいづちフレーズ（事前キャッシュ）
const FILLER_PHRASES = [
  "うん",
  "なるほどね",
  "あー",
  "うんうん",
  "へー",
];
const WAIT_PHRASES = [
  "ちょっと調べるね",
  "少し待ってね",
  "確認するね",
];
const fillerCache = new Map(); // phrase → audioPath
const waitCache = new Map();

// 起動時にあいづち・待ち音声をキャッシュ
async function preloadFillers() {
  console.log('🔊 Pre-generating filler audio...');
  for (const phrase of FILLER_PHRASES) {
    try {
      const path = await synthesizeSpeech(phrase);
      if (path) fillerCache.set(phrase, path);
    } catch {}
  }
  for (const phrase of WAIT_PHRASES) {
    try {
      const path = await synthesizeSpeech(phrase);
      if (path) waitCache.set(phrase, path);
    } catch {}
  }
  console.log(`🔊 Cached ${fillerCache.size} fillers + ${waitCache.size} wait phrases`);
}

/**
 * キャッシュからランダムなフレーズと音声パスを取得（ファイルは消さない）
 */
function getRandomCachedEntry(cache) {
  const entries = [...cache.entries()];
  if (entries.length === 0) return null;
  const [phrase, audioPath] = entries[Math.floor(Math.random() * entries.length)];
  if (!existsSync(audioPath)) {
    cache.delete(phrase);
    return null;
  }
  return { phrase, audioPath };
}

/**
 * 即座に音声を再生（キューを通さず直接再生）
 */
function playImmediate(audioPath) {
  return new Promise((resolve) => {
    const resource = createAudioResource(audioPath);
    player.play(resource);
    const onIdle = () => { player.off(AudioPlayerStatus.Idle, onIdle); resolve(); };
    player.on(AudioPlayerStatus.Idle, onIdle);
    setTimeout(resolve, 3000); // safety timeout
  });
}

client.once('ready', async () => {
  console.log(`🐾 Voice Bot ready as ${client.user.tag}`);
  preloadFillers(); // 非同期でキャッシュ開始

  // テキストチャンネル取得
  if (TEXT_CHANNEL_ID) {
    try {
      textChannel = await client.channels.fetch(TEXT_CHANNEL_ID);
      console.log(`📝 Text channel: #${textChannel.name}`);
    } catch (e) {
      console.error('Failed to fetch text channel:', e.message);
    }
  }

  if (VOICE_CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
      if (channel?.isVoiceBased()) {
        joinVC(channel);
        console.log(`🎙️ Auto-joined voice channel: ${channel.name}`);
      }
    } catch (e) {
      console.error('Failed to auto-join voice channel:', e.message);
    }
  }
});

// 「黙って」ボタンのインタラクション処理
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === 'stop_speaking') {
    if (isBotSpeaking) {
      console.log(`🔇 Stop button pressed by ${interaction.user.displayName}`);
      bargeIn();
      await interaction.reply({ content: '🔇 止めたよ', ephemeral: true });
    } else {
      await interaction.reply({ content: '今は話してないよ', ephemeral: true });
    }
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (newState.member.user.bot) return;
  if (newState.channelId === VOICE_CHANNEL_ID && oldState.channelId !== VOICE_CHANNEL_ID) {
    console.log(`👤 ${newState.member.displayName} joined voice`);
    if (currentConnection) setupUserListener(currentConnection, newState.member);
  }
  if (oldState.channelId === VOICE_CHANNEL_ID && newState.channelId !== VOICE_CHANNEL_ID) {
    console.log(`👤 ${oldState.member.displayName} left voice`);
    userRecordings.delete(oldState.member.id);
  }
});

function joinVC(channel) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  connection.subscribe(player);
  currentConnection = connection;

  connection.on(VoiceConnectionStatus.Ready, () => {
    console.log('✅ Voice connection ready');
    const vc = client.channels.cache.get(channel.id);
    if (vc?.members) {
      for (const [, member] of vc.members) {
        if (!member.user.bot) setupUserListener(connection, member);
      }
    }
  });

  connection.on('error', (err) => {
    console.error('⚠️ Voice connection error:', err.message);
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(`🔄 Voice state: ${oldState.status} → ${newState.status}`);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      console.log('🔄 Reconnecting to voice channel...');
      try {
        connection.rejoin({
          channelId: channel.id,
          selfDeaf: false,
          selfMute: false,
        });
      } catch {
        connection.destroy();
        currentConnection = null;
        userRecordings.clear();
      }
    }
  });
}

/**
 * PCMバッファのRMS（Root Mean Square）音量を計算
 */
function calculateRMS(pcmBuffer) {
  const samples = pcmBuffer.length / 2;
  if (samples === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}

function setupUserListener(connection, member) {
  const userId = member.id;
  if (userRecordings.has(userId)) return;

  const receiver = connection.receiver;

  receiver.speaking.on('start', (speakingUserId) => {
    if (speakingUserId !== userId) return;

    const state = userRecordings.get(userId);
    if (state?.recording) return;

    // Bot再生中: RMSベースの割り込み検出のみ（STTは開かない）
    if (isBotSpeaking) {
      console.log(`🔊 Bot speaking — barge-in listener active for ${member.displayName}`);
      const bargeInDecoder = new OpusScript(48000, 1, OpusScript.Application.VOIP);
      let loudStartTime = null;
      let bargeInTriggered = false;
      let packetCount = 0;

      const bargeInStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });

      bargeInStream.on('data', (packet) => {
        if (bargeInTriggered || isPlayingBargeInResponse) return;
        try {
          const pcm = Buffer.from(bargeInDecoder.decode(packet));
          const rms = calculateRMS(pcm);
          packetCount++;
          // 最初の数パケットだけRMS値をログ出力（デバッグ用）
          if (packetCount <= 5 || packetCount % 50 === 0) {
            console.log(`🔊 Barge-in RMS: ${Math.round(rms)} (packet #${packetCount}, threshold: ${BARGE_IN_RMS_THRESHOLD})`);
          }

          if (rms > BARGE_IN_RMS_THRESHOLD) {
            if (!loudStartTime) {
              loudStartTime = Date.now();
            } else if (Date.now() - loudStartTime >= BARGE_IN_DURATION_MS) {
              // 閾値以上の音量が一定時間続いた → 割り込み
              bargeInTriggered = true;
              console.log(`⚡ Barge-in detected from ${member.displayName} (RMS: ${Math.round(rms)}, duration: ${Date.now() - loudStartTime}ms)`);
              bargeIn();
              bargeInStream.destroy();
            }
          } else {
            // 音量が下がったらリセット
            loudStartTime = null;
          }
        } catch {}
      });

      bargeInStream.on('end', () => {
        try { bargeInDecoder.delete(); } catch {}
      });

      bargeInStream.on('error', () => {
        try { bargeInDecoder.delete(); } catch {}
      });

      return; // STTセッションは開かない
    }

    console.log(`🎤 ${member.displayName} started speaking`);

    const opusDecoder = new OpusScript(48000, 1, OpusScript.Application.VOIP);
    let packetCount = 0;

    const sttSession = createStreamingSTT();
    const sttStart = Date.now();

    sttSession.waitReady().then(ok => {
      if (!ok) console.warn('⚠️ STT connection may not be ready');
    });

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_DURATION_MS },
    });

    userRecordings.set(userId, { recording: true });

    opusStream.on('data', (packet) => {
      try {
        const pcm = Buffer.from(opusDecoder.decode(packet));
        packetCount++;
        sttSession.send(pcm);
      } catch {}
    });

    opusStream.on('end', async () => {
      userRecordings.set(userId, { recording: false });
      try { opusDecoder.delete(); } catch {}

      if (packetCount < MIN_AUDIO_PACKETS) {
        console.log(`⏭️ Audio too short (${packetCount} packets)`);
        sttSession.close();
        return;
      }

      await sttSession.waitReady();

      console.log(`📝 Finishing STT for ${member.displayName} (${packetCount} packets)`);
      const text = await sttSession.finish();
      const sttTime = Date.now() - sttStart;

      if (!text || text.trim().length === 0) {
        console.log(`⏭️ Empty transcription, skipping (STT: ${sttTime}ms)`);
        return;
      }
      // エコー/ノイズフィルタ: Whisperが出力する無意味なテキストを除去
      const NOISE_PATTERNS = [
        /^\(.*\)$/,       // (音楽), (笑), (拍手) etc.
        /^\[.*\]$/,       // [音楽], [笑] etc.
        /^ご視聴ありがとうございました$/,
        /^字幕/,
        /^MBS/i,
        /^ん[!！。]?$/,   // 「ん!」「ん。」だけ
      ];
      if (NOISE_PATTERNS.some(p => p.test(text.trim()))) {
        console.log(`⏭️ Filtered noise: "${text}" (STT: ${sttTime}ms)`);
        return;
      }

      console.log(`💬 ${member.displayName}: "${text}" (STT: ${sttTime}ms)`);

      if (isProcessing) {
        console.log(`⏭️ Skipping "${text}" — already processing a response`);
        return;
      }
      console.log(`🚀 Starting processResponse for "${text.substring(0, 30)}..."`);
      processResponse(text, member).catch(e => {
        console.error('Pipeline error:', e);
        isProcessing = false;
      });
    });

    opusStream.on('error', () => {
      userRecordings.set(userId, { recording: false });
      try { opusDecoder.delete(); } catch {}
      sttSession.close();
    });
  });

  userRecordings.set(userId, { recording: false });
  console.log(`👂 Listening to ${member.displayName}`);
}

/**
 * 割り込み処理: Botの再生を即座に停止し、キューをクリア
 */
const BARGE_IN_PHRASES = [
  "あ、了解、止めるね",
  "はいはい、聞いてる",
  "おっと、どうぞ",
  "あ、ごめん。どうぞ",
];

function bargeIn() {
  currentResponseAborted = true;
  while (playbackQueue.length > 0) {
    const item = playbackQueue.shift();
    try { unlinkSync(item.filePath); } catch {}
    item.resolve();
  }
  player.stop(true);

  const phrase = BARGE_IN_PHRASES[Math.floor(Math.random() * BARGE_IN_PHRASES.length)];
  console.log(`💬 Barge-in response: "${phrase}"`);
  isPlayingBargeInResponse = true;
  synthesizeSpeech(phrase).then(audioPath => {
    if (audioPath) {
      const resource = createAudioResource(audioPath);
      player.play(resource);
      player.once(AudioPlayerStatus.Idle, () => {
        isPlayingBargeInResponse = false;
        try { unlinkSync(audioPath); } catch {}
      });
    } else {
      isPlayingBargeInResponse = false;
    }
  }).catch(() => { isPlayingBargeInResponse = false; });
}

async function processResponse(text, member) {
  isProcessing = true;
  let waitTimer = null;
  try {
  const llmStart = Date.now();
  let firstChunkTime = 0;
  const fullResponse = [];
  currentResponseAborted = false;

  // ② 待ち緩和タイマー: 5秒以内にLLM応答がなければ「ちょっと待ってね」
  let waitPlayed = false;
  waitTimer = setTimeout(async () => {
    if (!firstChunkTime && !currentResponseAborted) {
      const waitEntry = getRandomCachedEntry(waitCache);
      if (waitEntry) {
        waitPlayed = true;
        console.log(`💬 Wait phrase: "${waitEntry.phrase}" (LLM taking long)`);
        if (textChannel) textChannel.send(`🐾 **クロウ**: ${waitEntry.phrase}`).catch(() => {});
        await playImmediate(waitEntry.audioPath);
      }
    }
  }, 5000);

  // ユーザーの発言をテキストチャンネルに投稿
  if (textChannel) {
    await textChannel.send(`🎤 **${member.displayName}**: ${text}`).catch(() => {});
  }

  // ① あいづちを即再生（ユーザーテキストの後に表示）
  const fillerEntry = getRandomCachedEntry(fillerCache);
  if (fillerEntry) {
    console.log(`💬 Filler: "${fillerEntry.phrase}"`);
    if (textChannel) textChannel.send(`🐾 **クロウ**: ${fillerEntry.phrase}`).catch(() => {});
    await playImmediate(fillerEntry.audioPath);
  }

  let botMessage = null;

  // 「黙って」ボタン付きのメッセージを作成
  const stopButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('stop_speaking')
      .setLabel('🔇 黙って')
      .setStyle(ButtonStyle.Secondary)
  );

  for await (const sentence of generateResponseStream(text, `discord:${member.id}`)) {
    if (currentResponseAborted) {
      console.log(`⚡ Response aborted by barge-in, skipping remaining chunks`);
      break;
    }

    if (!firstChunkTime) {
      clearTimeout(waitTimer); // 待ちタイマー解除
      firstChunkTime = Date.now() - llmStart;
      console.log(`🤖 First chunk (${firstChunkTime}ms): "${sentence}"`);
    } else {
      console.log(`🤖 Chunk: "${sentence}"`);
    }

    fullResponse.push(sentence);

    if (textChannel) {
      const currentText = `🐾 **クロウ**: ${fullResponse.join('')}`;
      if (!botMessage) {
        botMessage = await textChannel.send({ content: currentText, components: [stopButton] }).catch(() => null);
      } else {
        botMessage.edit({ content: currentText, components: [stopButton] }).catch(() => {});
      }
    }

    if (currentResponseAborted) break;

    const ttsStart = Date.now();
    const audioPath = await synthesizeSpeech(sentence);
    if (audioPath) {
      if (currentResponseAborted) {
        try { unlinkSync(audioPath); } catch {}
        break;
      }
      console.log(`🔊 TTS: ${Date.now() - ttsStart}ms`);
      await queueAndPlay(audioPath);
    }
  }

  // 応答完了後、ボタンを除去
  if (botMessage) {
    const finalText = `🐾 **クロウ**: ${fullResponse.join('')}${currentResponseAborted ? ' *(中断)*' : ''}`;
    botMessage.edit({ content: finalText, components: [] }).catch(() => {});
  }
  } finally {
    if (waitTimer) clearTimeout(waitTimer);
    isProcessing = false;
  }
}

function queueAndPlay(filePath) {
  return new Promise((resolve) => {
    playbackQueue.push({ filePath, resolve });
    if (!isPlaying) drainQueue();
  });
}

async function drainQueue() {
  isPlaying = true;
  isBotSpeaking = true;
  while (playbackQueue.length > 0) {
    if (currentResponseAborted) break;
    const { filePath, resolve } = playbackQueue.shift();
    try {
      await playAudio(filePath);
    } catch (e) {
      if (!currentResponseAborted) console.error('Playback error:', e);
    }
    try { unlinkSync(filePath); } catch {}
    resolve();
  }
  isPlaying = false;
  isBotSpeaking = false;
}

function playAudio(filePath) {
  return new Promise((resolve, reject) => {
    const resource = createAudioResource(filePath);
    player.play(resource);

    const onIdle = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
    };

    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);
  });
}

process.on('SIGINT', () => {
  console.log('👋 Shutting down...');
  if (currentConnection) currentConnection.destroy();
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_BOT_TOKEN);
