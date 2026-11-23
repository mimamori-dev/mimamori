import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// 遠隔(スマホ)は既定で無効。環境変数 OFFICE_REMOTE=1 のときだけ有効(公開版はオプトイン)
export const isRemoteEnabled = (env = process.env) => env.OFFICE_REMOTE === '1';

// Tailscale は 100.64.0.0/10 (CGNAT 帯)の宛先をこの PC に付ける。ここ以外には遠隔の口を開かない
export function findTailscaleIp(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [o1, o2] = a.address.split('.').map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return null;
}

// 合言葉は PC 内の remote.json(gitignore)にだけ置く。無ければ初回に作る
export function loadOrCreateToken(dir) {
  const file = path.join(dir, 'remote.json');
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8')).token;
    if (typeof t === 'string' && t.length >= 16) return t;
  } catch { /* 無い・壊れていれば作り直す */ }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, JSON.stringify({ token }, null, 2));
  return token;
}

// 合言葉と世代番号。世代は remote.json の generation(無ければ 0)
export function loadRemoteConfig(dir) {
  const token = loadOrCreateToken(dir);
  let generation = 0;
  try {
    const g = JSON.parse(fs.readFileSync(path.join(dir, 'remote.json'), 'utf8')).generation;
    if (Number.isInteger(g) && g > 0) generation = g;
  } catch { /* 読めなければ 0 */ }
  return { token, generation };
}

// OFFICE_REMOTE_DIR の解釈。未指定・空文字(空白のみ含む)は既定の dir。
// 指定があるのに絶対パスでない・存在しない・ディレクトリでない・読み書きできないときは、理由つきで dir:null を返す
export function resolveRemoteDir(env, defaultDir) {
  const raw = typeof env.OFFICE_REMOTE_DIR === 'string' ? env.OFFICE_REMOTE_DIR.trim() : '';
  if (!raw) return { dir: defaultDir, custom: false };
  if (!path.isAbsolute(raw)) return { dir: null, custom: true, reason: 'OFFICE_REMOTE_DIR は絶対パスで指定してください' };
  try {
    if (!fs.statSync(raw).isDirectory()) return { dir: null, custom: true, reason: 'OFFICE_REMOTE_DIR がフォルダではありません' };
    fs.accessSync(raw, fs.constants.R_OK | fs.constants.W_OK);
  } catch (e) {
    return { dir: null, custom: true, reason: e.code === 'ENOENT' ? 'OFFICE_REMOTE_DIR のフォルダが存在しません' : 'OFFICE_REMOTE_DIR のフォルダを読み書きできません' };
  }
  return { dir: raw, custom: true };
}

// Tailscale が後から起動しても拾えるよう、見つかるまで定期的に確かめる。
// 無効なら Tailscale を探さず、合言葉ファイルも作らず null を返す
export function startRemoteWatcher(handle, dir, { intervalMs = 30_000, env = process.env, findIp = findTailscaleIp, port, warn = (m) => console.warn(m) } = {}) {
  if (!isRemoteEnabled(env)) return null;
  // 合言葉を OneDrive 等の同期フォルダ外に置けるよう、OFFICE_REMOTE_DIR があればそちらを使う
  const r = resolveRemoteDir(env, dir);
  const configDir = r.dir;
  // 不正な指定のまま既定の場所へ黙って切り替えない(意図と違う場所に合言葉を置かないため)。理由は1回だけ出す
  if (!configDir) warn(`Mimamori (remote): ${r.reason}。遠隔(スマホ)は有効にしません。`);
  let warnedWrite = false;
  const tick = async () => {
    if (!configDir) return false;
    try {
      if (handle.remotePort()) return true;
      const host = findIp();
      if (!host) return false;
      const ok = await handle.enableRemote({ host, ...loadRemoteConfig(configDir), ...(port === undefined ? {} : { port }) });
      if (ok) console.log(`Mimamori (remote): http://${host}:${handle.remotePort()}/ (合言葉付き)`);
      return ok;
    } catch (e) {
      if (!warnedWrite) { warnedWrite = true; warn(`Mimamori (remote): 合言葉ファイルを読み書きできず、遠隔を有効にできません(${e.code ?? e.name})。30秒ごとに再試行します。`); }
      return false;
    }
  };
  const t = setInterval(tick, intervalMs);
  t.unref();
  t.first = tick();
  return t;
}
