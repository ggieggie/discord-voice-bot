import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const VOICEVOX_URL = process.env.VOICEVOX_URL || 'http://127.0.0.1:50021';
const SPEAKER_ID = parseInt(process.env.VOICEVOX_SPEAKER_ID || '3', 10); // ずんだもん ノーマル

/**
 * Synthesize speech using VOICEVOX
 * @param {string} text - Text to speak
 * @returns {Promise<string|null>} Path to generated WAV file
 */
export async function synthesizeSpeech(text) {
  try {
    // 1. Audio query (テキスト解析)
    const queryRes = await fetch(
      `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(text)}&speaker=${SPEAKER_ID}`,
      { method: 'POST' }
    );
    if (!queryRes.ok) {
      console.error('VOICEVOX audio_query failed:', queryRes.status);
      return null;
    }
    const query = await queryRes.json();

    // Speed up slightly for more natural conversation
    query.speedScale = 1.5;
    query.pitchScale = 0.0;
    query.intonationScale = 1.2;
    query.pauseLengthScale = 0.25;
    query.outputSamplingRate = 48000; // Discord Opus(48kHz)に合わせてリサンプリング不要に

    // 2. Synthesis (音声合成)
    const synthRes = await fetch(
      `${VOICEVOX_URL}/synthesis?speaker=${SPEAKER_ID}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
      }
    );
    if (!synthRes.ok) {
      console.error('VOICEVOX synthesis failed:', synthRes.status);
      return null;
    }

    const audioBuffer = Buffer.from(await synthRes.arrayBuffer());
    const filePath = join(tmpdir(), `voice-bot-${randomUUID()}.wav`);
    writeFileSync(filePath, audioBuffer);

    return filePath;
  } catch (e) {
    console.error('TTS error:', e.message);
    return null;
  }
}
