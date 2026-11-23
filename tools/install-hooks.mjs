// office-hook.mjs を呼ぶ hook を .claude/settings.json に足す・取り除く。
// 使い方: node tools/install-hooks.mjs [--project <dir> | --user] [--dry-run] [--yes] [--uninstall]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_SCRIPT = path.resolve(here, '..', 'office-hook.mjs');

// 元の運用設定に合わせる。SessionStart だけは同期(起動時の接続確認)、他は async
export const EVENTS = [
  { event: 'SessionStart', async: false },
  { event: 'UserPromptSubmit', async: true },
  { event: 'PreToolUse', async: true, matcher: '*' },
  { event: 'SubagentStart', async: true },
  { event: 'SubagentStop', async: true },
  { event: 'Stop', async: true },
  { event: 'Notification', async: true },
];

// 絶対パスをダブルクォートで囲む。Windows でもシェルで崩れないよう / 区切りにする(node は / を受け付ける)
export function hookCommand(script = HOOK_SCRIPT) {
  const p = script.replace(/\\/g, '/');
  if (/["`$]/.test(p)) throw new Error(`パスに使えない文字(ダブルクォート・バッククォート・$)が含まれています: ${p}`);
  return `node "${p}"`;
}

const entryFor = (spec, command) => {
  const hook = { type: 'command', command, timeout: 5 };
  if (spec.async) hook.async = true;
  const e = { hooks: [hook] };
  if (spec.matcher) e.matcher = spec.matcher;
  return e;
};
const hasCommand = (entry, command) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => h?.command === command);

// settings を壊さずに追加した新しいオブジェクトと、追加した event の一覧を返す
export function addHooks(settings, command) {
  const next = structuredClone(settings ?? {});
  const added = [];
  if (next.hooks !== undefined && (typeof next.hooks !== 'object' || next.hooks === null || Array.isArray(next.hooks))) throw new Error('settings.json の hooks がオブジェクトではありません');
  next.hooks ??= {};
  for (const spec of EVENTS) {
    const list = next.hooks[spec.event];
    if (list !== undefined && !Array.isArray(list)) throw new Error(`hooks.${spec.event} が配列ではありません`);
    const arr = list ?? [];
    if (arr.some((e) => hasCommand(e, command))) continue;
    arr.push(entryFor(spec, command));
    next.hooks[spec.event] = arr;
    added.push(spec.event);
  }
  return { settings: next, added };
}

// 自分の command だけを取り除く。空になった entry・event・hooks は片づける
export function removeHooks(settings, command) {
  const next = structuredClone(settings ?? {});
  const removed = [];
  if (!next.hooks || typeof next.hooks !== 'object') return { settings: next, removed };
  for (const [event, list] of Object.entries(next.hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = [];
    for (const e of list) {
      if (!hasCommand(e, command)) { kept.push(e); continue; }
      const rest = e.hooks.filter((h) => h?.command !== command);
      removed.push(event);
      if (rest.length) kept.push({ ...e, hooks: rest });
    }
    if (kept.length) next.hooks[event] = kept; else delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

// 導入済みの event 一覧(doctor 用)
export const installedEvents = (settings, command) => EVENTS.filter((s) => Array.isArray(settings?.hooks?.[s.event]) && settings.hooks[s.event].some((e) => hasCommand(e, command))).map((s) => s.event);

export function settingsPath({ user, project }) {
  return user ? path.join(os.homedir(), '.claude', 'settings.json') : path.join(path.resolve(project ?? process.cwd()), '.claude', 'settings.json');
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d+)Z$/, '$1').replace('T', '-');

export function parseArgs(argv) {
  const o = { user: false, project: null, dryRun: false, yes: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') o.user = true;
    else if (a === '--project') { o.project = argv[++i]; if (!o.project) throw new Error('--project にはフォルダを指定してください'); }
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--uninstall') o.uninstall = true;
    else throw new Error(`知らない引数です: ${a}`);
  }
  if (o.user && o.project) throw new Error('--user と --project は同時に指定できません');
  return o;
}

const confirm = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answered = false;
  rl.question(q, (a) => { answered = true; rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  rl.on('close', () => { if (!answered) resolve(false); });
});

export async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(e.message); return 1; }
  const file = settingsPath(o);
  let command;
  try { command = hookCommand(); } catch (e) { console.error(e.message); return 1; }
  let before = {};
  let existed = false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    existed = true;
    before = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    if (e.code !== 'ENOENT') { console.error(`${file} を読めません(壊れたJSONの可能性)。何も変更しません: ${e.message}`); return 1; }
  }
  if (typeof before !== 'object' || before === null || Array.isArray(before)) { console.error(`${file} の中身がオブジェクトではありません。何も変更しません`); return 1; }
  let result;
  try { result = o.uninstall ? removeHooks(before, command) : addHooks(before, command); } catch (e) { console.error(`${e.message}。何も変更しません`); return 1; }
  const changed = o.uninstall ? result.removed : result.added;
  console.log(`対象: ${file}${existed ? '' : '(まだ無いので新規作成)'}`);
  console.log(`hook: ${command}`);
  if (!changed.length) { console.log(o.uninstall ? '取り除くものはありません(未導入)。' : 'すでに導入済みです。変更なし。'); return 0; }
  console.log(`${o.uninstall ? '取り除く' : '追加する'}イベント:`);
  for (const ev of changed) console.log(`  ${o.uninstall ? '-' : '+'} ${ev}`);
  if (o.dryRun) { console.log('--dry-run のため書き込みません。'); return 0; }
  if (!o.yes && !(await confirm(`${o.uninstall ? '取り除き' : '書き込み'}ますか? (y/N) `))) { console.log('中止しました。'); return 0; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (existed) {
    const bak = `${file}.bak-${stamp()}`;
    fs.copyFileSync(file, bak);
    console.log(`バックアップ: ${bak}`);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(result.settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
  console.log(o.uninstall ? '取り除きました。' : '導入しました。Claude Code を再起動(または /hooks で確認)してください。');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
