// 読み上げ用の中継。VOICEVOX エンジン(任意)に、同一PC内(127.0.0.1)の HTTP で文を渡して wav を受け取る。
export const TTS_TEXT_MAX = 400;
export const TTS_BODY_MAX = 4 * 1024;
const DEFAULT_URL = 'http://127.0.0.1:50021';

export function createTts({ baseUrl = DEFAULT_URL, timeoutMs = 10_000, maxInflight = 2 } = {}) {
  const u = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('VOICEVOX の宛先は同じPC(127.0.0.1)だけです');
  const base = u.origin;
  let inflight = 0;
  return {
    // 失敗(エンジン無し・応答なし・時間切れ)は throw。呼び出し側が 503 にする
    async synthesize(text, speaker) {
      if (inflight >= maxInflight) { const e = new Error('busy'); e.busy = true; throw e; }
      inflight++;
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const q = await fetch(`${base}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`, { method: 'POST', signal });
        if (!q.ok) throw new Error(`audio_query ${q.status}`);
        const query = await q.text();
        const w = await fetch(`${base}/synthesis?speaker=${speaker}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: query, signal });
        if (!w.ok) throw new Error(`synthesis ${w.status}`);
        return Buffer.from(await w.arrayBuffer());
      } finally { inflight--; }
    },
  };
}
