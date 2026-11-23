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

// Tailscale が後から起動しても拾えるよう、見つかるまで定期的に確かめる。
// 無効なら Tailscale を探さず、合言葉ファイルも作らず null を返す
export function startRemoteWatcher(handle, dir, { intervalMs = 30_000, env = process.env, findIp = findTailscaleIp, port } = {}) {
  if (!isRemoteEnabled(env)) return null;
  // 合言葉を OneDrive 等の同期フォルダ外に置けるよう、OFFICE_REMOTE_DIR があればそちらを使う
  const configDir = env.OFFICE_REMOTE_DIR || dir;
  const tick = async () => {
    try {
      if (handle.remotePort()) return true;
      const host = findIp();
      if (!host) return false;
      const ok = await handle.enableRemote({ host, ...loadRemoteConfig(configDir), ...(port === undefined ? {} : { port }) });
      if (ok) console.log(`Mimamori (remote): http://${host}:${handle.remotePort()}/ (合言葉付き)`);
      return ok;
    } catch { return false; }
  };
  const t = setInterval(tick, intervalMs);
  t.unref();
  t.first = tick();
  return t;
}
