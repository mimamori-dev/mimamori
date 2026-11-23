// 読み上げ用の中継。VOICEVOX エンジン(任意)に、同一PC内(127.0.0.1)の HTTP で文を渡して wav を受け取る。
export const TTS_TEXT_MAX = 400;
export const TTS_BODY_MAX = 4 * 1024;
export const WAV_MAX = 20 * 1024 * 1024;

// 応答本文を上限つきで読む(超えたら中止して throw)
async function readLimited(res, max) {
  if (Number(res.headers.get('content-length')) > max) throw new Error('too large');
  const chunks = [];
  let n = 0;
  for await (const c of res.body) { n += c.length; if (n > max) throw new Error('too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}
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
        const q = await fetch(`${base}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`, { method: 'POST', signal, redirect: 'error' });
        if (!q.ok) throw new Error(`audio_query ${q.status}`);
        const query = await q.text();
        const w = await fetch(`${base}/synthesis?speaker=${speaker}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: query, signal, redirect: 'error' });
        if (!w.ok) throw new Error(`synthesis ${w.status}`);
        return await readLimited(w, WAV_MAX);
      } finally { inflight--; }
    },
  };
}
