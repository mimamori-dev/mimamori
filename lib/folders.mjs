import fs from 'node:fs';
import path from 'node:path';

// 画面からの「フォルダを選ぶ」の部品。フォルダ名だけを返し、中身(ファイル)は読まない。
// 選んだ基準フォルダは data/project-roots.json に保存する(project.json は git に入るので、個人のパスを書かない)。

export const BROWSE_MAX = 500;
const SKIP = (name) => name.startsWith('.') || name.startsWith('$') || name.toLowerCase() === 'node_modules';

const okPathString = (raw) => typeof raw === 'string' && raw.length <= 1024 && !raw.includes('\0');

// 絶対パスだけを受ける。空文字は「一番上」(Windows ならドライブ一覧、それ以外は /)
export function browseDirs(raw) {
  if (raw === '' || raw === undefined || raw === null) return topLevel();
  if (!okPathString(raw) || !path.isAbsolute(raw)) return { status: 400 };
  const abs = path.resolve(raw);
  let real;
  try {
    real = fs.realpathSync(abs);
    if (!fs.statSync(real).isDirectory()) return { status: 404 };
  } catch { return { status: 404 }; }
  let dirents;
  try { dirents = fs.readdirSync(real, { withFileTypes: true }); } catch { return { status: 403 }; } // 読めないフォルダ
  const entries = [];
  for (const d of dirents) {
    if (SKIP(d.name)) continue;
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) { try { isDir = fs.statSync(path.join(real, d.name)).isDirectory(); } catch { /* 壊れたリンクは出さない */ } }
    if (isDir) entries.push({ name: d.name });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  const parent = path.dirname(real) === real ? '' : path.dirname(real);
  return { status: 200, body: { path: real, parent, entries: entries.slice(0, BROWSE_MAX), truncated: entries.length > BROWSE_MAX, isRoot: path.dirname(real) === real } };
}

function topLevel() {
  if (process.platform !== 'win32') return browseDirs('/');
  const entries = [];
  for (let c = 65; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    try { if (fs.existsSync(drive)) entries.push({ name: drive }); } catch { /* 無いドライブ */ }
  }
  return { status: 200, body: { path: '', parent: null, entries, truncated: false, isRoot: true, drives: true } };
}

// 基準フォルダとして使えるか。使えるなら実体の絶対パスを返す。ドライブ直下(/ や C:\)は広すぎるので断る
export function checkRootChoice(raw) {
  if (!okPathString(raw) || !path.isAbsolute(raw)) return { ok: false, reason: '絶対パスで指定してください' };
  let real;
  try {
    real = fs.realpathSync(path.resolve(raw));
    if (!fs.statSync(real).isDirectory()) return { ok: false, reason: 'フォルダではありません' };
    fs.readdirSync(real);
  } catch { return { ok: false, reason: '開けないフォルダです' }; }
  if (path.dirname(real) === real) return { ok: false, reason: 'ドライブ直下は選べません。その中のフォルダを選んでください' };
  return { ok: true, root: real };
}

export function loadRootOverrides(file, warn = console.warn) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') warn(`[projects] ${file} を読めないため、保存したフォルダは使いません(${e.message})`);
    return {};
  }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
}

// 失敗したら例外(呼び出し側で保存できなかったと伝える)
export function saveRootOverride(file, id, root) {
  const all = loadRootOverrides(file, () => {});
  all[id] = root;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
