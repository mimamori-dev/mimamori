// 作業見積もり: 仕事を振る前の予想(トークン・5時間枠%・週枠%)と、終わった後の実績を並べて持つ。
// メモリは最大 MAX 件(古いものから捨てる)。追記ログ(JSONL)は振り返り用で、ファイルが書けなくても動く。
import fs from 'node:fs';
import path from 'node:path';

export const ESTIMATE_MAX = 30;
export const TITLE_MAX = 80;
export const NOTE_MAX = 200;
const TOKENS_MAX = 1e10;

const len = (s) => Array.from(s).length;
const tokenOk = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= TOKENS_MAX;
const pctOk = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const absent = (v) => v === undefined || v === null;

// 数値欄(省略可)。不正なら { bad: true }
function pick(body, key, ok) {
  if (absent(body[key])) return { value: null };
  return ok(body[key]) ? { value: body[key] } : { bad: true };
}

export function createEstimates({ file = null, project = 'demo', now = Date.now, max = ESTIMATE_MAX } = {}) {
  const items = []; // 古い順
  let next = 1;
  const log = (rec) => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify({ ts: now(), project, ...rec })}\n`); } catch { /* ログが書けなくても画面は動く */ }
  };

  // 戻り値: { id } / null(不正)
  function add(body) {
    if (typeof body.title !== 'string') return null;
    const title = body.title.trim();
    if (!title || len(title) > TITLE_MAX) return null;
    let note = '';
    if (!absent(body.note)) {
      if (typeof body.note !== 'string' || len(body.note.trim()) > NOTE_MAX) return null;
      note = body.note.trim();
    }
    const t = pick(body, 'tokens', tokenOk);
    const f = pick(body, 'fiveHourPct', pctOk);
    const w = pick(body, 'weekPct', pctOk);
    if (t.bad || f.bad || w.bad) return null;
    const e = { id: `e${next++}`, ts: now(), title, note, tokens: t.value, fiveHourPct: f.value, weekPct: w.value, actualTokens: null, actualFiveHourPct: null, actualWeekPct: null, done: false };
    items.push(e);
    while (items.length > max) items.shift();
    log({ op: 'add', ...e });
    return { id: e.id };
  }

  // 戻り値: 'ok' / 'bad' / 'missing'
  function update(body) {
    if (typeof body.id !== 'string') return 'bad';
    const e = items.find((x) => x.id === body.id);
    const t = pick(body, 'actualTokens', tokenOk);
    const f = pick(body, 'actualFiveHourPct', pctOk);
    const w = pick(body, 'actualWeekPct', pctOk);
    if (t.bad || f.bad || w.bad) return 'bad';
    if (!absent(body.done) && typeof body.done !== 'boolean') return 'bad';
    if (!e) return 'missing';
    if (t.value !== null) e.actualTokens = t.value;
    if (f.value !== null) e.actualFiveHourPct = f.value;
    if (w.value !== null) e.actualWeekPct = w.value;
    if (typeof body.done === 'boolean') e.done = body.done;
    log({ op: 'update', id: e.id, title: e.title, actualTokens: e.actualTokens, actualFiveHourPct: e.actualFiveHourPct, actualWeekPct: e.actualWeekPct, done: e.done });
    return 'ok';
  }

  return { add, update, list: () => items.map((e) => ({ ...e })) };
}
