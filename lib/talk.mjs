import fs from 'node:fs/promises';
import path from 'node:path';

// ターミナルでの部長(本体)の発言を、transcript(jsonl)の末尾から取り出す。
// 読むのは assistant の text ブロックだけ(思考・ツール呼び出し・ツール結果は読まない)。
export const FIRST_TAIL_BYTES = 64 * 1024; // 初めて見るファイルは末尾この分だけ
export const MAX_READ_BYTES = 256 * 1024; // 1回に読む上限(大きく空いたら古い所は捨てる)
const SEEN_MAX = 300;

function inside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// jsonl の行の並びから部長のテキストを取り出す。サブエージェント(isSidechain)は対象外
export function extractSay(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    if (!raw || !raw.includes('"assistant"')) continue;
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (o?.type !== 'assistant' || o.isSidechain === true || !Array.isArray(o.message?.content)) continue;
    const parts = o.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()).map((b) => b.text.trim());
    if (parts.length) out.push({ key: typeof o.uuid === 'string' ? o.uuid : null, text: parts.join('\n\n') });
  }
  return out;
}

export function createTalkReader({ allowedRoot }) {
  const root = path.resolve(allowedRoot);
  const pos = new Map(); // path -> 読み取り済みバイト位置
  const seen = new Set(); // 行の uuid(位置のずれがあっても二重に送らない)

  // 前回より後の発言を返す。失敗・範囲外のファイルは空配列(例外にしない)
  async function read(p) {
    const abs = path.resolve(String(p));
    if (path.extname(abs) !== '.jsonl' || !inside(root, abs)) return [];
    let fh;
    try {
      fh = await fs.open(abs, 'r');
      const { size } = await fh.stat();
      let start = pos.get(abs);
      let partialStart = false;
      if (start === undefined) { start = Math.max(0, size - FIRST_TAIL_BYTES); partialStart = start > 0; }
      else if (size < start) start = 0; // 切り詰められたら先頭から
      if (size - start > MAX_READ_BYTES) { start = size - MAX_READ_BYTES; partialStart = true; }
      if (size === start) { pos.set(abs, start); return []; }
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      let chunk = buf.subarray(0, bytesRead);
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl < 0) return []; // 書きかけの1行だけ: 次回に回す
      let body = chunk.subarray(0, lastNl);
      if (partialStart) { const nl = body.indexOf(0x0a); body = nl < 0 ? Buffer.alloc(0) : body.subarray(nl + 1); } // 途中から始まった最初の行は捨てる
      pos.set(abs, start + lastNl + 1);
      const fresh = [];
      for (const s of extractSay(body.toString('utf8'))) {
        if (s.key) { if (seen.has(s.key)) continue; seen.add(s.key); }
        fresh.push(s.text);
      }
      while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
      return fresh;
    } catch {
      return [];
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  return { read };
}
