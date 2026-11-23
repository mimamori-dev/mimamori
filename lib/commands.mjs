import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const OUTPUT_MAX_LINES = 200;
export const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_MAX_BYTES = 512 * 1024; // 出し続けるコマンドでメモリを使い切らないための上限
// テスト実行の中から、再びテスト実行(= 自分自身)を起動しないための印
export const NO_RECURSE_ENV = 'OFFICE_IN_COMMAND';

// npm は Windows では .cmd で shell なしに起動できないため、node 同梱の npm-cli.js を直接使う。無ければ node --test(package.json の test と同じ)
function npmTestSpec() {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(cli) ? { cmd: process.execPath, args: [cli, 'test'] } : { cmd: process.execPath, args: ['--test'] };
}

// 許可リスト。状態を変える操作(再起動・コミット・削除・push・インストール)は載せない。引数は固定
export function defaultCommands({ officeDir, projectRoot, health }) {
  return [
    { id: 'test', label: 'テスト実行', ...npmTestSpec(), cwd: officeDir, recursionGuard: true },
    { id: 'git-status', label: '変更の確認', cmd: 'git', args: ['-c', 'core.quotepath=false', 'status', '--short'], cwd: projectRoot },
    { id: 'git-log', label: '履歴の確認', cmd: 'git', args: ['log', '--oneline', '-10'], cwd: projectRoot },
    { id: 'health', label: 'サーバーの状態', run: async () => JSON.stringify(health(), null, 2) },
  ];
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function clipOutput(text, maxLines) {
  const lines = text.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length <= maxLines) return { output: lines.join('\n'), truncated: false };
  // 結果の要約(テストの合計など)は末尾に出るので、後ろ側を残す
  return { output: lines.slice(-maxLines).join('\n'), truncated: true };
}

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false }).on('error', () => {});
    else child.kill('SIGKILL');
  } catch { /* 既に終わっている */ }
}

// 許可リストの外は実行しない。同時に走らせるのは1件まで
export function createCommandRunner({ commands, timeoutMs = COMMAND_TIMEOUT_MS, maxLines = OUTPUT_MAX_LINES, env = process.env } = {}) {
  const byId = new Map(commands.map((c) => [c.id, c]));
  let busy = false;

  const list = () => commands.map(({ id, label }) => ({ id, label }));

  // { status: 200|404|409, body } を返す。例外は出さない
  async function run(id) {
    const c = typeof id === 'string' ? byId.get(id) : undefined;
    if (!c) return { status: 404 };
    if (busy) return { status: 409 };
    busy = true;
    try {
      if (c.recursionGuard && env[NO_RECURSE_ENV] === '1') return { status: 200, body: { ok: false, output: 'テストの中からは実行しません', truncated: false } };
      return { status: 200, body: c.run ? await runInProcess(c) : await runSpawn(c) };
    } catch {
      return { status: 200, body: { ok: false, output: '実行できませんでした', truncated: false } };
    } finally {
      busy = false;
    }
  }

  async function runInProcess(c) {
    const out = await Promise.race([c.run(), new Promise((r) => setTimeout(() => r(null), timeoutMs).unref())]);
    if (out === null) return { ok: false, output: `${Math.round(timeoutMs / 1000)}秒で打ち切りました`, truncated: true, timedOut: true };
    return { ok: true, ...clipOutput(String(out), maxLines) };
  }

  function runSpawn(c) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(c.cmd, c.args, { cwd: c.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, [NO_RECURSE_ENV]: '1' } });
      } catch { resolve({ ok: false, output: '実行できませんでした', truncated: false }); return; }
      const chunks = [];
      let bytes = 0;
      let timedOut = false;
      let overflow = false;
      let finished = false;
      const take = (b) => {
        if (bytes >= OUTPUT_MAX_BYTES) { overflow = true; return; }
        bytes += b.length;
        chunks.push(b);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      timer.unref();
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const clipped = clipOutput(Buffer.concat(chunks).toString('utf8'), maxLines);
        const note = timedOut ? `\n(${Math.round(timeoutMs / 1000)}秒で打ち切りました)` : '';
        const out = (clipped.output + note).replace(/^\n/, '');
        resolve({ ok: ok && !timedOut, output: out, truncated: clipped.truncated || overflow || timedOut, ...(timedOut ? { timedOut: true } : {}) });
      };
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0));
    });
  }

  return { list, run, isBusy: () => busy };
}
