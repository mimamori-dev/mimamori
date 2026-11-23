import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, raw, openSse } from './helpers.mjs';

process.env.OFFICE_REMOTE = '1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-est-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const J = { 'Content-Type': 'application/json' };
let n = 0;

async function withServer(fn, opts = {}) {
  const logFile = path.join(dir, `d${n++}`, 'estimates.jsonl');
  const s = await startTestServer({ port: 0, allowedRoot: dir, estimatesFile: logFile, ...opts });
  try { await fn(s, logFile); } finally { await s.close(); }
}
const post = (s, p, body, headers = J) => raw(s.port, p, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const snapEstimates = async (s) => { const sse = await openSse(s); try { return (await sse.snapshot()).estimates; } finally { sse.close(); } };

test('登録と更新: id が返り、画面の snapshot と追記ログに出る', async () => {
  await withServer(async (s, logFile) => {
    const r = await post(s, '/estimate', { title: '調査', tokens: 50000, fiveHourPct: 4.5, weekPct: 1, note: 'メモ' });
    assert.equal(r.status, 201);
    const { id } = JSON.parse(r.text);
    let list = await snapEstimates(s);
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].title, list[0].tokens, list[0].fiveHourPct, list[0].done, list[0].actualTokens], ['調査', 50000, 4.5, false, null]);
    assert.equal((await post(s, '/estimate/update', { id, actualTokens: 65000, actualFiveHourPct: 5, done: true })).status, 204);
    list = await snapEstimates(s);
    assert.deepEqual([list[0].actualTokens, list[0].actualFiveHourPct, list[0].actualWeekPct, list[0].done], [65000, 5, null, true]);
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.op), ['add', 'update']);
    assert.equal(lines[1].actualTokens, 65000);
  });
});

test('任意項目は省略できる。存在しない id の更新は 404、id なしは 400', async () => {
  await withServer(async (s) => {
    assert.equal((await post(s, '/estimate', { title: 'だけ' })).status, 201);
    assert.equal((await post(s, '/estimate/update', { id: 'e999', actualTokens: 1 })).status, 404);
    assert.equal((await post(s, '/estimate/update', { actualTokens: 1 })).status, 400);
  });
});

test('最大30件: 古いものから捨てる。捨てた id の更新は 404', async () => {
  await withServer(async (s) => {
    for (let i = 1; i <= 32; i++) assert.equal((await post(s, '/estimate', { title: `t${i}` })).status, 201);
    const list = await snapEstimates(s);
    assert.equal(list.length, 30);
    assert.equal(list[0].title, 't3');
    assert.equal((await post(s, '/estimate/update', { id: 'e1', actualTokens: 1 })).status, 404);
  });
});

test('不正値は 400(負数・文字列・小数のトークン・巨大数・範囲外%・長い題/メモ・空題・型違い)', async () => {
  await withServer(async (s) => {
    const bad = [
      { title: 'a', tokens: -1 }, { title: 'a', tokens: '100' }, { title: 'a', tokens: 1.5 }, { title: 'a', tokens: 1e15 },
      { title: 'a', fiveHourPct: -0.1 }, { title: 'a', fiveHourPct: 101 }, { title: 'a', weekPct: 'x' },
      { title: 'あ'.repeat(81) }, { title: '   ' }, { title: 5 }, {}, { title: 'a', note: 'あ'.repeat(201) }, { title: 'a', note: 3 },
    ];
    for (const b of bad) assert.equal((await post(s, '/estimate', b)).status, 400, JSON.stringify(b).slice(0, 60));
    assert.equal((await post(s, '/estimate', { title: 'あ'.repeat(80), note: 'あ'.repeat(200), tokens: 0, fiveHourPct: 100 })).status, 201);
    const { id } = JSON.parse((await post(s, '/estimate', { title: 'b' })).text);
    for (const b of [{ actualTokens: -5 }, { actualTokens: 'x' }, { actualWeekPct: 200 }, { done: 'yes' }, { actualTokens: 1e15 }]) assert.equal((await post(s, '/estimate/update', { id, ...b })).status, 400);
    assert.equal((await post(s, '/estimate', '[1]')).status, 400);
    assert.equal((await post(s, '/estimate', '壊れたJSON')).status, 400);
    assert.equal((await post(s, '/estimate', { title: 'a' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await snapEstimates(s)).length, 2); // 不正は1件も増えない
  });
});

test('本文は4KBまで(超えると 413)', async () => {
  await withServer(async (s) => {
    assert.equal((await post(s, '/estimate', { title: 'a', note: 'x'.repeat(5000) })).status, 413);
    assert.equal((await snapEstimates(s)).length, 0);
  });
});

test('他サイト由来は 403', async () => {
  await withServer(async (s) => {
    assert.equal((await post(s, '/estimate', { title: 'a' }, { ...J, Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(s, '/estimate', { title: 'a' }, { ...J, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post(s, '/estimate/update', { id: 'e1' }, { ...J, Origin: 'http://evil.example' })).status, 403);
    assert.equal((await snapEstimates(s)).length, 0);
  });
});

test('遠隔(スマホ)は登録・更新とも 403', async () => {
  await withServer(async (s) => {
    assert.equal((await post(s, '/estimate', { title: '秘密の題', tokens: 123 })).status, 201);
    const TOKEN = 'test-token-0123456789abcdef';
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const rp = s.remotePort();
    const rr = (p) => raw(rp, p, { method: 'POST', headers: { ...J, Host: `127.0.0.1:${rp}`, Cookie: `office_key=${TOKEN}` }, body: '{"title":"x"}' });
    assert.equal((await rr('/estimate')).status, 403);
    assert.equal((await rr(`/estimate?k=${TOKEN}`)).status, 403);
    assert.equal((await rr('/estimate/update')).status, 403);
    assert.equal((await snapEstimates(s)).length, 1);
  });
});

test('XSS: 題・メモは textContent で入れる(panels.js が HTML として解釈しない)', () => {
  const src = fs.readFileSync(new URL('../public/panels.js', import.meta.url), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src));
  assert.match(src, /el\('div', 'pn-card-title', e\.title\)/);
  assert.match(src, /el\('div', 'pn-card-meta', e\.note\)/);
});
