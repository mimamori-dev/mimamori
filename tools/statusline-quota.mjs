// statusLine コマンド: 利用枠(5時間・週間)の使用率と回復時刻だけをオフィスへ送る。
// ステータス行には何も出さず、失敗しても必ず終了コード0・1秒以内に終わる。
const port = Number(process.env.OFFICE_PORT ?? 4317);
// 既定は従来どおり。負荷の高いテスト機でだけ環境変数で延ばす
const sendMs = Number(process.env.OFFICE_SEND_TIMEOUT_MS) || 800;
setTimeout(() => process.exit(0), sendMs + 200).unref();

const win = (w) => (w && typeof w === 'object' ? { pct: w.used_percentage, resetsAt: w.resets_at } : null);

try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const rl = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.rate_limits;
  const fiveHour = win(rl?.five_hour);
  const sevenDay = win(rl?.seven_day);
  if (fiveHour || sevenDay) {
    await fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: Date.now(), kind: 'quota', agentId: null, agentType: null, text: '', title: '', fiveHour, sevenDay }),
      signal: AbortSignal.timeout(sendMs),
    });
  }
} catch { /* 何があっても黙って終わる */ }
process.exit(0);
