// 遠隔(スマホ)の合言葉を作り直し、世代番号を上げる。既存の Cookie・QR は全て無効になる。
// 合言葉そのものは画面に出さない。使い方: node tools/remote-rotate.mjs [--yes]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const dir = process.env.OFFICE_REMOTE_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(dir, 'remote.json');

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
