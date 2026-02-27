import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENCLAW_GATEWAY_TOKEN,
  baseURL: process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789/v1',
});

const SYSTEM_PROMPT = `あなたはクロウ、Discord音声チャットで会話するAIアシスタントです。

あなたの構成：
- STT: Whisper.cppローカル（smallモデル、日本語）
- LLM: Claude Sonnet（OpenClaw Gateway経由）
- TTS: VOICEVOX ずんだもん（48kHz）

重要なルール：
- 音声で話すので、短く自然な話し言葉で答えてください
- マークダウンや記号は使わないでください（絵文字も不要）
- 1〜2文で簡潔に答えてください。長くならないで
- 日本語で話してください
- 親しみやすく、でも丁寧に
- ツールや検索は使わず、知っている知識だけで答えてください
- 分からないことは「ちょっと分からないな」と正直に言ってOK`;

/**
 * Generate a response via OpenClaw Gateway with streaming.
 * Yields sentence chunks as they become available.
 * @param {string} userMessage
 * @param {string} userId
 * @returns {AsyncGenerator<string>} sentence chunks
 */
export async function* generateResponseStream(userMessage, userId) {
  try {
    const stream = await openai.chat.completions.create({
      model: 'anthropic/claude-sonnet-4-20250514',
      user: `voice:${userId}`,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 100,
    });

    let buffer = '';
    // Sentence-ending patterns for Japanese
    const sentenceEnd = /[。！？\n]/;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (!delta) continue;

      buffer += delta;

      // Check for sentence boundaries
      let match;
      while ((match = sentenceEnd.exec(buffer)) !== null) {
        const sentence = buffer.substring(0, match.index + 1).trim();
        buffer = buffer.substring(match.index + 1);
        if (sentence.length > 0) {
          yield sentence;
        }
      }
    }

    // Yield remaining buffer
    if (buffer.trim().length > 0) {
      yield buffer.trim();
    }
  } catch (e) {
    console.error('LLM error:', e.message);
    yield 'ごめん、ちょっとエラーが起きちゃった。';
  }
}

/**
 * Non-streaming version (kept for compatibility)
 */
export async function generateResponse(userMessage, userId) {
  const chunks = [];
  for await (const chunk of generateResponseStream(userMessage, userId)) {
    chunks.push(chunk);
  }
  return chunks.join('');
}
