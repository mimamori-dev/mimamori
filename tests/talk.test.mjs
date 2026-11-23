import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, openSse } from './helpers.mjs';
import { extractSay, createTalkReader, FIRST_TAIL_BYTES, MAX_READ_BYTES } from '../lib/talk.mjs';
import { createState, applyEvent, snapshot } from '../lib/state.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-talk-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const roster = JSON.parse(fs.readFileSync(new URL('../roster.json', import.meta.url), 'utf8'));
const TOKEN = 'test-token-0123456789abcdef';
const SECRET = '金額は1,234,567円です';

let n = 0;
const asst = (blocks, o = {}) => JSON.stringify({ type: 'assistant', uuid: `u${++n}`, isSidechain: false, message: { id: `m${n}`, role: 'assistant', content: blocks, usage: { input_tokens: 1, output_tokens: 1 } }, ...o }) + '\n';
const text = (t) => asst([{ type: 'text', text: t }]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('extractSay: assistant の text だけ。思考・ツール呼び出し・ツール結果・ユーザー・サブエージェントは除く', () => {
  const lines = [
    text('途中経過です'),
    asst([{ type: 'thinking', thinking: '秘密の考え' }]),
    asst([{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }]),
    asst([{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '前半' }, { type: 'text', text: '後半' }]),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ツール結果' }] } }) + '\n',
    JSON.stringify({ type: 'user', message: { role: 'user', content: '社長の指示本文' } }) + '\n',
    asst([{ type: 'text', text: 'サブエージェントの発言' }], { isSidechain: true }),
    asst([{ type: 'text', text: '   ' }]),
    asst('文字列のcontent'),
    'not json\n',
    '{"type":"assistant"}\n',
  ].join('');
  assert.deepEqual(extractSay(lines).map((x) => x.text), ['途中経過です', '前半\n\n後半']);
});

test('createTalkReader: 位置を覚えて重複して返さない。書きかけの行は次回に回す。範囲外・不正は空配列', async () => {
  const p = path.join(dir, 'a.jsonl');
  fs.writeFileSync(p, text('一つ目'));
  const r = createTalkReader({ allowedRoot: dir });
  assert.deepEqual(await r.read(p), ['一つ目']);
  assert.deepEqual(await r.read(p), []);
  fs.appendFileSync(p, text('二つ目') + text('三つ目'));
  assert.deepEqual(await r.read(p), ['二つ目', '三つ目']);
  const half = text('四つ目');
  fs.appendFileSync(p, half.slice(0, 20));
  assert.deepEqual(await r.read(p), []);
  fs.appendFileSync(p, half.slice(20));
  assert.deepEqual(await r.read(p), ['四つ目']);
  // 切り詰め(位置より小さい)は先頭から読み直すが、同じ uuid は重ねない
  fs.writeFileSync(p, text('作り直し'));
  assert.deepEqual(await r.read(p), ['作り直し']);
  for (const bad of [path.join(os.tmpdir(), 'outside.jsonl'), path.join(dir, 'x.txt'), path.join(dir, 'none.jsonl'), '', null, 5, undefined]) assert.deepEqual(await r.read(bad), [], String(bad));
});

test('createTalkReader: 初めて見る大きなファイルは末尾だけ読み、途中から始まる行は捨てる。大きく空いたら古い所は読まない', async () => {
  const p = path.join(dir, 'big.jsonl');
  const old = '古い発言'.repeat(50);
  let body = '';
  while (Buffer.byteLength(body) < FIRST_TAIL_BYTES * 3) body += text(old);
  body += text('最後の発言');
  fs.writeFileSync(p, body);
  const r = createTalkReader({ allowedRoot: dir });
  const got = await r.read(p);
  assert.ok(got.length >= 1 && got.length < body.split('\n').length / 2, `got ${got.length}`);
  assert.equal(got.at(-1), '最後の発言');
  assert.ok(got.every((t) => t === '最後の発言' || t === old), '途中から始まった壊れた行は含まない');
  let more = '';
  while (Buffer.byteLength(more) < MAX_READ_BYTES * 2) more += text(old);
  fs.appendFileSync(p, more + text('新しい発言'));
  const got2 = await r.read(p);
  assert.equal(got2.at(-1), '新しい発言');
  assert.ok(got2.length < more.split('\n').length / 2);
});

test('state: say は部長の愛称で最大100件・1500字に切る。サブエージェントの say と空は無視。snapshot の talk は PC だけ', () => {
  const s = createState(roster);
  for (let i = 0; i < 105; i++) applyEvent(s, { ts: i + 1, kind: 'say', agentId: null, text: `発言${i}` });
  applyEvent(s, { ts: 999, kind: 'say', agentId: 'a1', agentType: 'x', text: 'サブ' });
  applyEvent(s, { ts: 999, kind: 'say', agentId: null, text: '   ' });
  applyEvent(s, { ts: 1000, kind: 'say', agentId: null, text: 'あ'.repeat(2000) });
  const local = snapshot(s, Date.now(), { local: true }).talk;
  assert.equal(local.length, 100);
  assert.equal(local.at(-1).text.length, 1500);
  assert.equal(local[0].text, '発言6');
  assert.equal(local.at(-1).who, s.seats.get('bucho').nickname);
  assert.deepEqual(Object.keys(local[0]).sort(), ['text', 'ts', 'who']);
  assert.ok(!('talk' in snapshot(s)));
  assert.ok(!JSON.stringify(snapshot(s)).includes('発言'));
  assert.equal(snapshot(s, Date.now(), { local: true }).log.some((l) => l.text.includes('発言')), false);
});

async function withServer(fn) {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try { await fn(s); } finally { await s.close(); }
}
const postEv = (s, ev) => fetch(`http://127.0.0.1:${s.port}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ts: Date.now(), agentId: null, agentType: null, text: '', ...ev }) });
async function localTalk(s) { const sse = await openSse(s); try { return (await sse.snapshot()).talk; } finally { sse.close(); } }
async function until(fn, ms = 4000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(40); } }

test('サーバー: transcriptPath 付きのイベントで発言が talk に入り、同じ発言は重ならない', async () => {
  await withServer(async (s) => {
    const tp = path.join(dir, 'main.jsonl');
    fs.writeFileSync(tp, text('調べます') + asst([{ type: 'thinking', thinking: '内緒' }]));
    await postEv(s, { kind: 'prompt', title: 't', transcriptPath: tp });
    let t = await until(async () => { const x = await localTalk(s); return x?.length >= 1 ? x : null; });
    assert.deepEqual(t.map((x) => x.text), ['調べます']);
    await postEv(s, { kind: 'tool', text: 'x', toolName: 'Read', toolArg: 'a', transcriptPath: tp });
    fs.appendFileSync(tp, text('次の報告'));
    await postEv(s, { kind: 'stop', text: '社長に報告', transcriptPath: tp });
    await until(async () => (await localTalk(s)).length >= 2);
    await sleep(150);
    t = await localTalk(s);
    assert.deepEqual(t.map((x) => x.text), ['調べます', '次の報告']);
    assert.ok(t.every((x) => typeof x.ts === 'number' && x.who));
  });
});

function collect(url, headers) {
  const ac = new AbortController();
  const out = { buf: '', stop: () => ac.abort() };
  (async () => {
    try {
      const res = await fetch(url, { signal: ac.signal, headers });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; out.buf += dec.decode(value, { stream: true }); }
    } catch { /* abort */ }
  })();
  return out;
}

test('サーバー: 遠隔(スマホ)の snapshot・SSE のイベント・ログに発言の本文は出ない', async () => {
  await withServer(async (s) => {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    const url = `http://127.0.0.1:${s.remotePort()}/events`;
    const remote = collect(url, { Cookie: `office_key=${TOKEN}` });
    await until(() => remote.buf.includes('event: snapshot'));
    const tp = path.join(dir, 'remote.jsonl');
    fs.writeFileSync(tp, text(SECRET));
    await postEv(s, { kind: 'tool', text: 'x', toolName: 'Read', toolArg: 'a', transcriptPath: tp });
    await until(async () => (await localTalk(s))?.some((x) => x.text === SECRET)); // PC には出る
    await postEv(s, { kind: 'stop', text: '社長に報告', transcriptPath: tp });
    await until(() => (remote.buf.match(/event: office/g) ?? []).length >= 3);
    await sleep(200);
    remote.stop();
    assert.ok(remote.buf.includes('"kind":"say"'), '発言のイベント自体は届く(本文なし)');
    assert.ok(!remote.buf.includes(SECRET) && !remote.buf.includes('1,234,567'), 'SSE に本文が出ていない');
    assert.ok(!remote.buf.includes('"talk"'));
    // 外部から say を直接送られても、遠隔には本文を流さない
    const r2 = collect(url, { Cookie: `office_key=${TOKEN}` });
    await until(() => r2.buf.includes('event: snapshot'));
    await postEv(s, { kind: 'say', text: '偽造の発言' });
    await until(() => r2.buf.includes('"kind":"say"'));
    r2.stop();
    assert.ok(!r2.buf.includes('偽造の発言'));
  });
});

test('サーバー: 範囲外の transcriptPath は読まない', async () => {
  await withServer(async (s) => {
    const outside = path.join(os.tmpdir(), `office-outside-${process.pid}.jsonl`);
    fs.writeFileSync(outside, text('範囲外の発言'));
    try {
      await postEv(s, { kind: 'tool', text: 'x', toolName: 'Read', toolArg: 'a', transcriptPath: outside });
      await sleep(400);
      assert.deepEqual(await localTalk(s), []);
    } finally { fs.rmSync(outside, { force: true }); }
  });
});
