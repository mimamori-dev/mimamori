import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// hook は作業を止めてはいけないので、何が起きても例外・出力・非0終了を出さない
const port = Number(process.env.OFFICE_PORT ?? 4317);
const base = `http://127.0.0.1:${port}`;
// import.meta.url 基準にする(cwd や日本語を含むパスに依存しない)
const serverPath = fileURLToPath(new URL('./office-server.mjs', import.meta.url));
// --project <id> で、このhookがどのプロジェクトのものかを宣言する。省略時は送らない(サーバーが demo として扱う)
const projectArg = (() => { const i = process.argv.indexOf('--project'); return i > 0 && typeof process.argv[i + 1] === 'string' ? process.argv[i + 1] : null; })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function health(timeoutMs) {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function detach(cmd, args) {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => {});
  p.unref();
}

async function ensureServerAndBrowser() {
  let h = await health(300);
  if (!h) {
    detach(process.execPath, [serverPath]);
    for (let i = 0; i < 20 && !h; i++) {
      await sleep(100);
      h = await health(300);
    }
  }
  if (h && h.clients === 0 && !process.env.OFFICE_NO_BROWSER && process.platform === 'win32') {
    detach('cmd', ['/c', 'start', '', `${base}/`]);
  }
}

try {
  const input = JSON.parse(await readStdin());
  // 静的 import だと describe.mjs の構文エラーで終了コード1になるので、ここで読んで失敗も握りつぶす
  const { toOfficeEvent } = await import('./lib/describe.mjs');
  const built = toOfficeEvent(input, Date.now());
  // 発信元の照合用に宣言と cwd を足す(サーバーが、cwd・transcript から導いたプロジェクトと食い違えば捨てる)。認証情報らしい文字列は送る前に伏せる
  const { sanitizeEvent } = await import('./lib/guard.mjs');
  const ev = built ? sanitizeEvent({ ...built, ...(projectArg ? { project: projectArg } : {}), ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}) }) : null;
  if (ev) {
    if (ev.kind === 'session_start') await ensureServerAndBrowser();
    await fetch(`${base}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(500),
    });
  }
} catch { /* 送れなくても作業は続ける */ }
process.exitCode = 0;
