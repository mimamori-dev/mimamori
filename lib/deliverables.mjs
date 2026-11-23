import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 成果物ボード: 登録された成果物のパス検証と、既定のアプリで開く処理。
// パスはサーバー内にだけ持ち、画面・遠隔には出さない(画面に出すのはファイル名まで)。

// 開いてよい拡張子(許可リスト)と、画面の種類
export const ALLOWED_EXT = {
  mp4: 'video', pdf: 'pdf', pptx: 'pptx', xlsx: 'xlsx', csv: 'xlsx', docx: 'doc', md: 'doc', txt: 'doc', json: 'doc', html: 'html', htm: 'html', png: 'image', jpg: 'image',
};
// 許可リストが正だが、実行ファイル系は名指しでも拒否する(許可リストを誤って広げても開けない)
export const DENIED_EXT = new Set(['exe', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs', 'wsf', 'wsh', 'lnk', 'msi', 'msp', 'com', 'scr', 'pif', 'hta', 'cpl', 'reg', 'jar', 'dll', 'sh', 'py', 'url', 'appref-ms', 'gadget', 'application']);
export const KINDS = new Set(['video', 'pdf', 'pptx', 'xlsx', 'html', 'doc', 'image', 'other']);
const HIDDEN_SEGMENTS = new Set(['.git', 'node_modules', '.claude', 'secrets']);
// 認証情報のファイル名(.env / .env.* / .dev.vars* / *.pem / *.key)。拡張子の許可リストを通る名前(.env.json など)も名指しで拒否する
export const isSecretFileName = (name) => /^\.env(\..*)?$/i.test(name) || /^\.dev\.vars/i.test(name) || /\.(pem|key)$/i.test(name);

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (root, p) => { const a = norm(root); const b = norm(p); return b !== a && b.startsWith(a + path.sep); };

// 入力のパス(絶対、または root からの相対)を検査する。
// 戻り値: { ok:true, real, fileName, kind } | { ok:false, reason }。reason は短い固定文(パスは含めない)
export function checkDeliverablePath(root, input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 1024) return { ok: false, reason: 'パスが不正です' };
  // NUL・代替データストリーム(:)・UNC・末尾の . や空白(Windows が名前を丸める)は断る
  if (/\0/.test(input) || /^[\\/]{2}/.test(input) || input.slice(2).includes(':') || /^[A-Za-z]:(?![\\/])/.test(input) || /[<>"|?*]/.test(input) || /[. ]$/.test(input)) return { ok: false, reason: 'パスが不正です' };
  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync.native(root);
    real = fs.realpathSync.native(path.resolve(realRoot, input));
  } catch { return { ok: false, reason: 'ファイルが見つかりません' }; }
  if (!inside(realRoot, real)) return { ok: false, reason: 'プロジェクトの外のファイルは開けません' };
  const segs = path.relative(realRoot, real).split(path.sep);
  if (segs.some((s) => HIDDEN_SEGMENTS.has(s.toLowerCase())) || isSecretFileName(path.basename(real))) return { ok: false, reason: 'この場所のファイルは開けません' };
  try { if (!fs.statSync(real).isFile()) return { ok: false, reason: '通常のファイルではありません' }; } catch { return { ok: false, reason: 'ファイルが見つかりません' }; }
  const fileName = path.basename(real);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (DENIED_EXT.has(ext) || !Object.hasOwn(ALLOWED_EXT, ext)) return { ok: false, reason: 'この種類のファイルは開けません' };
  return { ok: true, real, fileName, kind: ALLOWED_EXT[ext] };
}

// 既定のアプリで開く。shell を介さず、引数配列で渡す(パスの中身がコマンドとして解釈されない)。
// Windows は explorer.exe(関連付けられたアプリで開く)。結果は「起動できたか」だけ
export function openWithDefaultApp(real) {
  return new Promise((resolve) => {
    let cmd;
    let args;
    if (process.platform === 'win32') { cmd = 'explorer.exe'; args = [real]; }
    else if (process.platform === 'darwin') { cmd = 'open'; args = [real]; }
    else { cmd = 'xdg-open'; args = [real]; }
    try {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
      p.once('error', () => resolve(false));
      p.once('spawn', () => { p.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}
