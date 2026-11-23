// 回答掲示板へ「相談の要約(100字まで)」と「回答の要点(300字まで)」を送る。失敗しても終了コード0。
// 使い方: node tools/post-answer.mjs "相談" "回答"  /  日本語が化けるときは: echo '{"question":"..","answer":".."}' | node tools/post-answer.mjs --stdin
const port = Number(process.env.OFFICE_PORT ?? 4317);
const clip = (v, n) => (typeof v === 'string' ? [...v.trim()].slice(0, n).join('') : '');
// 既定は従来どおり。負荷の高いテスト機でだけ環境変数で延ばす
const sendMs = Number(process.env.OFFICE_SEND_TIMEOUT_MS) || 2000;
setTimeout(() => process.exit(0), sendMs + 1000).unref();

try {
  let question = process.argv[2];
  let answer = process.argv[3];
  if (process.argv.includes('--stdin')) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    ({ question, answer } = JSON.parse(Buffer.concat(chunks).toString('utf8')) ?? {});
  }
  question = clip(question, 100);
  answer = clip(answer, 300);
  if (question && answer) {
    await fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: Date.now(), kind: 'answer', agentId: null, agentType: null, text: '', title: '', question, answer }),
      signal: AbortSignal.timeout(sendMs),
    });
  }
} catch { /* 黙って終わる */ }
process.exit(0);
