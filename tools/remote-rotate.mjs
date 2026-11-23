// 遠隔(スマホ)の合言葉を作り直し、世代番号を上げる。既存の Cookie・QR は全て無効になる。
// 合言葉そのものは画面に出さない。使い方: node tools/remote-rotate.mjs [--yes]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { resolveRemoteDir } from '../lib/remote-config.mjs';

const resolved = resolveRemoteDir(process.env, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
if (!resolved.dir) { console.error(`${resolved.reason}。変更していません。`); process.exit(2); }
const dir = resolved.dir;
const file = path.join(dir, 'remote.json');

// サーバーが別の場所(OFFICE_REMOTE_DIR)を使っていると気づけるよう、作成先だけ出す(合言葉は出さない)
console.log(`作成先: ${file}${resolved.custom ? '' : '(OFFICE_REMOTE_DIR 未指定。サーバーに指定している場合は同じ値を付けて実行してください)'}`);

if (!process.argv.includes('--yes')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('遠隔の合言葉を作り直します(スマホは再接続が必要になります)。続けますか? [y/N] ')).trim().toLowerCase();
  rl.close();
  if (a !== 'y' && a !== 'yes') { console.log('中止しました(変更なし)。'); process.exit(1); }
}

let generation = 0;
try { const g = JSON.parse(fs.readFileSync(file, 'utf8')).generation; if (Number.isInteger(g) && g > 0) generation = g; } catch { /* 無ければ 0 */ }
generation += 1;
const token = crypto.randomBytes(24).toString('base64url');
fs.writeFileSync(file, JSON.stringify({ token, generation }, null, 2));
console.log(`合言葉を作り直しました(世代 ${generation})。サーバーを再起動して、PC の画面の QR をスマホで読み取り直してください。`);
