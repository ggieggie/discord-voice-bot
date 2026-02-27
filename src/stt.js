/**
 * STT Module - Whisper.cpp Server (メイン) + Whisper API (フォールバック)
 * 
 * メイン: whisper.cpp server（ローカルHTTP、モデル常駐、高速）
 * フォールバック: OpenAI Whisper API
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WHISPER_SERVER_URL = process.env.WHISPER_SERVER_URL || 'http://127.0.0.1:8178';

let useLocalServer = false;

// Check whisper-server availability
(async () => {
  try {
    const resp = await fetch(`${WHISPER_SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      useLocalServer = true;
      console.log('🎙️ Whisper.cpp server: ✅ ready (local, primary STT)');
    }
  } catch {
    console.warn('⚠️ Whisper.cpp server not available');
  }

  if (!useLocalServer && OPENAI_API_KEY) {
    console.log('🎙️ Whisper API: ✅ key configured (fallback STT)');
  } else if (!useLocalServer) {
    console.warn('⚠️ No STT backend available!');
  }
})();

/**
 * Whisper.cpp Server STTセッション
 */
function createLocalServerSTT() {
  const chunks = [];
  let resolved = false;

  return {
    async waitReady() { return true; },

    send(pcmBuffer) {
      if (!resolved) chunks.push(Buffer.from(pcmBuffer));
    },

    async finish() {
      if (resolved) return '';
      resolved = true;
      if (chunks.length === 0) return '';

      const prepStart = Date.now();
      const pcm = Buffer.concat(chunks);
      const down = downsample(pcm, 48000, 16000);
      const wav = pcmToWav(down, 16000, 1, 16);
      console.log(`📊 STT prep: ${Date.now() - prepStart}ms, WAV: ${(wav.length/1024).toFixed(0)}KB, chunks: ${chunks.length}`);

      try {
        const boundary = '----WhisperBoundary' + Date.now();
        const bodyParts = [];
        bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
        bodyParts.push(wav);
        bodyParts.push(Buffer.from('\r\n'));
        bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nja\r\n`));
        bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`));
        bodyParts.push(Buffer.from(`--${boundary}--\r\n`));
        const body = Buffer.concat(bodyParts);

        const whisperStart = Date.now();
        const resp = await fetch(`${WHISPER_SERVER_URL}/inference`, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) {
          console.error(`❌ Whisper server error (${resp.status})`);
          return '';
        }

        const data = await resp.json();
        console.log(`📊 Whisper inference: ${Date.now() - whisperStart}ms`);
        // whisper-server returns { text: "..." }
        return (data?.text || '').trim();
      } catch (e) {
        console.error('❌ Whisper server error:', e.message);
        return '';
      }
    },

    close() { resolved = true; },
  };
}

/**
 * Whisper API STTセッション（フォールバック）
 */
function createWhisperAPISTT() {
  const chunks = [];
  let resolved = false;

  return {
    async waitReady() { return true; },

    send(pcmBuffer) {
      if (!resolved) chunks.push(Buffer.from(pcmBuffer));
    },

    async finish() {
      if (resolved) return '';
      resolved = true;
      if (chunks.length === 0) return '';

      const pcm = Buffer.concat(chunks);
      const down = downsample(pcm, 48000, 16000);
      const wav = pcmToWav(down, 16000, 1, 16);

      try {
        const boundary = '----WhisperBoundary' + Date.now();
        const bodyParts = [];
        bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
        bodyParts.push(wav);
        bodyParts.push(Buffer.from('\r\n'));
        bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`));
        bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nja\r\n`));
        bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`));
        bodyParts.push(Buffer.from(`--${boundary}--\r\n`));
        const body = Buffer.concat(bodyParts);

        const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
        });

        if (!resp.ok) {
          console.error(`❌ Whisper API error (${resp.status})`);
          return '';
        }

        const data = await resp.json();
        return data?.text?.trim() || '';
      } catch (e) {
        console.error('❌ Whisper API error:', e.message);
        return '';
      }
    },

    close() { resolved = true; },
  };
}

/**
 * STTセッション作成
 */
export function createStreamingSTT() {
  if (useLocalServer) {
    return createLocalServerSTT();
  }
  if (OPENAI_API_KEY) {
    return createWhisperAPISTT();
  }
  console.error('❌ No STT backend available');
  return { async waitReady() { return false; }, send() {}, async finish() { return ''; }, close() {} };
}

function downsample(pcmBuffer, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const srcSamples = pcmBuffer.length / 2;
  const dstSamples = Math.floor(srcSamples / ratio);
  const result = Buffer.alloc(dstSamples * 2);
  for (let i = 0; i < dstSamples; i++) {
    result.writeInt16LE(pcmBuffer.readInt16LE(Math.floor(i * ratio) * 2), i * 2);
  }
  return result;
}

function pcmToWav(pcmBuffer, sampleRate, numChannels, bitsPerSample) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);
  return buffer;
}
