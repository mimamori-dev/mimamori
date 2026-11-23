// 環境の自己診断。出力はそのまま GitHub Issue に貼れる(ホームのパスは ~ に置換)。
// 使い方: npm run doctor [-- --project <dir>]   (hook の確認先。既定はカレントフォルダ)
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjects } from '../lib/projects.mjs';
import { hookCommand, installedEvents, settingsPath, EVENTS } from './install-hooks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ホームのフォルダ名(ユーザー名)を出力に残さない。\ と / と大文字小文字の違いを吸収する
export function maskHome(text, home = os.homedir()) {
  const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')]);
  let out = String(text);
  for (const v of variants) out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '~');
  return out;
}

export const portFree = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? false : null));
  s.listen(port, host, () => s.close(() => resolve(true)));
});

const readSettings = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export async function runDoctor({ projectDir = process.cwd(), env = process.env, officeDir = root, home = os.homedir() } = {}) {
  const rows = []; // [項目, 状態, 詳細]
  const add = (name, ok, detail) => rows.push([name, ok === null ? '未確認' : ok ? 'OK' : 'NG', detail]);

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 20, `${process.versions.node}(20以上が必要)`);
  add('OS', process.platform === 'win32' ? true : null, `${process.platform} ${os.release()}(動作確認は Windows のみ。それ以外は未確認)`);

  const hasModules = fs.existsSync(path.join(officeDir, 'node_modules', 'three'));
  add('node_modules', hasModules, hasModules ? 'three あり' : '無いか不完全です。`npm ci` を実行してください');

  const port = Number(env.OFFICE_PORT ?? 4317);
  const free = await portFree(port);
  rows.push([`ポート ${port}`, free === true ? 'OK' : free === false ? '使用中' : '未確認', free === true ? '空いています' : free === false ? 'すでに起動中か、別のアプリが使っています。起動できないときは OFFICE_PORT を変える(hook・tools にも同じ指定が必要)' : '確認できませんでした']);

  const warns = [];
  let reg = null;
  try { reg = loadProjects({ projectsDir: process.env.OFFICE_PROJECTS_DIR ? path.resolve(process.env.OFFICE_PROJECTS_DIR) : path.join(officeDir, 'projects'), legacyRosterPath: path.join(officeDir, 'roster.json'), defaultRoot: null, warn: (m) => warns.push(m) }); } catch (e) { warns.push(`[projects] 読み込み失敗: ${e.message}`); }
  add('projects', warns.length === 0 && reg !== null, reg ? `読めたもの: ${[...reg.keys()].join(', ')}${warns.length ? `(警告 ${warns.length} 件)` : ''}` : '読めませんでした');

  let cmd = null;
  try { cmd = hookCommand(path.join(officeDir, 'office-hook.mjs')); } catch (e) { add('hook', false, e.message); }
  if (cmd) {
    const places = [['プロジェクト', settingsPath({ project: projectDir })], ['ユーザー', path.join(home, '.claude', 'settings.json')]];
    const found = [];
    for (const [label, f] of places) {
      const s = readSettings(f);
      const ev = s ? installedEvents(s, cmd) : [];
      if (ev.length) found.push(`${label}(${ev.length}/${EVENTS.length}件): ${f}`);
    }
    add('hook', found.length > 0, found.length ? found.join(' / ') : '未導入です。`node tools/install-hooks.mjs --user`(全プロジェクト)または `--project <フォルダ>`(そのフォルダだけ)で導入できます');
  }

  const lines = ['## Mimamori doctor', '', '| 項目 | 状態 | 詳細 |', '| --- | --- | --- |'];
  for (const [n, st, d] of rows) lines.push(`| ${n} | ${st} | ${d.replace(/\|/g, '/')} |`);
  if (warns.length) lines.push('', '### projects の警告', ...warns.map((w) => `- ${w}`));
  const ng = rows.filter((r) => r[1] === 'NG').length;
  lines.push('', ng ? `NG が ${ng} 件あります。` : 'NG はありません。');
  return { text: maskHome(lines.join('\n'), home), ng };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--project');
  runDoctor({ projectDir: i > 0 ? process.argv[i + 1] : process.cwd() }).then((r) => { console.log(r.text); process.exitCode = r.ng ? 1 : 0; });
}
