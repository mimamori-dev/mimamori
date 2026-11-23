import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createState, applyEvent, snapshot } from '../lib/state.mjs';

const roster = JSON.parse(readFileSync(new URL('../roster.json', import.meta.url), 'utf8'));
let t = 1000;
const ev = (kind, o = {}) => ({ ts: ++t, kind, agentId: null, agentType: null, text: '', transcriptPath: null, agentTranscriptPath: null, ...o });
const delegate = (type, title = '依頼') => ev('delegate', { text: `${type}に依頼します`, title, targetType: type });
const start = (id, type) => ev('subagent_start', { agentId: id, agentType: type, text: '作業を始めます' });
const done = (id, type) => ev('subagent_done', { agentId: id, agentType: type, text: 'できました' });
const seat = (s, id) => snapshot(s).members.find((m) => m.seat === id);
const cards = (s, owner) => snapshot(s).board.filter((c) => c.owner === owner);
const ownerOf = (type) => roster.members.find((m) => (m.types ?? [m.type]).includes(type)).name;

test('順序A(delegate が先): 従来どおり count 1、pending は担当の開始で消費され、完了で戻る', () => {
  const s = createState(roster);
  applyEvent(s, delegate('implementer', 'サーバーを直す'));
  assert.equal(seat(s, 'implementer').count, 1);
  assert.equal(s.pending.length, 1);
  applyEvent(s, start('a1', 'implementer'));
  assert.equal(s.pending.length, 0);
  assert.equal(seat(s, 'implementer').count, 1);
  assert.equal(cards(s, ownerOf('implementer')).length, 1);
  applyEvent(s, done('a1', 'implementer'));
  assert.equal(seat(s, 'implementer').count, 0);
  assert.equal(seat(s, 'implementer').status, 'done');
  assert.equal(s.seats.get('implementer').busy, false);
});

test('順序B(SubagentStart が先): 後から来た delegate が席を引き継ぎ、count は1のまま・pending は積まない・完了で working が戻る', () => {
  const s = createState(roster);
  applyEvent(s, start('a1', 'implementer'));
  assert.equal(seat(s, 'implementer').count, 1);
  assert.equal(seat(s, 'implementer').status, 'working');
  applyEvent(s, delegate('implementer', 'サーバーを直す'));
  assert.equal(seat(s, 'implementer').count, 1); // 二重にしない
  assert.equal(s.pending.length, 0); // 消費されない pending を残さない
  const cs = cards(s, ownerOf('implementer'));
  assert.equal(cs.length, 1); // カードも1枚のまま
  assert.equal(cs[0].title, 'サーバーを直す'); // 件名は委任のものに
  assert.equal(snapshot(s).counters.delegates, 1);
  applyEvent(s, done('a1', 'implementer'));
  assert.equal(seat(s, 'implementer').count, 0);
  assert.equal(seat(s, 'implementer').status, 'done');
  assert.equal(s.seats.get('implementer').busy, false);
  assert.equal(s.orphans.length, 0);
});

test('同じ席の2回目: 順序Aの2件・順序Bの2件・AとBの混在のいずれも、完了後に count 0 へ戻る', () => {
  // A + A
  let s = createState(roster);
  applyEvent(s, delegate('implementer', '一つ目'));
  applyEvent(s, delegate('implementer', '二つ目'));
  assert.equal(seat(s, 'implementer').count, 2);
  applyEvent(s, start('a1', 'implementer'));
  applyEvent(s, start('a2', 'implementer'));
  applyEvent(s, done('a1', 'implementer'));
  assert.equal(seat(s, 'implementer').status, 'working'); // もう1人が動いている間は working
  applyEvent(s, done('a2', 'implementer'));
  assert.deepEqual([seat(s, 'implementer').count, seat(s, 'implementer').status], [0, 'done']);
  // B + B
  s = createState(roster);
  applyEvent(s, start('a1', 'implementer'));
  applyEvent(s, start('a2', 'implementer'));
  assert.equal(seat(s, 'implementer').count, 2);
  applyEvent(s, delegate('implementer', '一つ目'));
  applyEvent(s, delegate('implementer', '二つ目'));
  assert.equal(seat(s, 'implementer').count, 2);
  assert.equal(s.pending.length, 0);
  assert.deepEqual(cards(s, ownerOf('implementer')).map((c) => c.title).sort(), ['一つ目', '二つ目']);
  applyEvent(s, done('a1', 'implementer'));
  applyEvent(s, done('a2', 'implementer'));
  assert.deepEqual([seat(s, 'implementer').count, seat(s, 'implementer').status], [0, 'done']);
  // B のあとに A(開始が先の1人 + 後から別の委任が先に届く1人)
  s = createState(roster);
  applyEvent(s, start('a1', 'implementer'));
  applyEvent(s, delegate('implementer', '一つ目')); // a1 が引き継ぐ
  applyEvent(s, delegate('implementer', '二つ目')); // 引き継ぐ席が無い = 順序A として pending
  assert.equal(seat(s, 'implementer').count, 2);
  assert.equal(s.pending.length, 1);
  applyEvent(s, start('a2', 'implementer')); // pending を消費
  applyEvent(s, done('a2', 'implementer'));
  applyEvent(s, done('a1', 'implementer'));
  assert.deepEqual([seat(s, 'implementer').count, seat(s, 'implementer').status, s.pending.length], [0, 'done', 0]);
});

test('種類が違えば引き継がない。stop で orphan も消え、次の作業に count が残らない', () => {
  const s = createState(roster);
  applyEvent(s, start('a1', 'implementer'));
  applyEvent(s, delegate('ui-builder', '画面'));
  assert.equal(seat(s, 'implementer').count, 1);
  assert.equal(seat(s, 'ui-builder').count, 1);
  assert.equal(s.pending.length, 1);
  applyEvent(s, ev('subagent_done', { agentId: 'a1', agentType: 'implementer', text: 'できました' })); // 動いている担当が残る間は stop でも席を維持するため、先に終える
  applyEvent(s, ev('stop', { text: '社長に報告' }));
  assert.ok(snapshot(s).members.every((m) => m.count === 0 && m.status === 'idle'));
  assert.deepEqual([s.orphans.length, s.pending.length], [0, 0]);
  applyEvent(s, delegate('implementer', '次'));
  assert.equal(seat(s, 'implementer').count, 1);
});

test('委任の通し番号: delegate イベントと snapshot に seq・種類・席が入り、順序に関係なく到着ごとに増える。本文は含めない', () => {
  const s = createState(roster);
  const a = delegate('implementer', '金額1,234,567円の件');
  applyEvent(s, a);
  assert.deepEqual(a.delegation, { seq: 1, type: 'implementer', seat: 'implementer' });
  const b = start('a2', 'ui-builder');
  applyEvent(s, b);
  const c = delegate('ui-builder', '画面');
  applyEvent(s, c); // 順序B(開始が先)
  assert.deepEqual(c.delegation, { seq: 2, type: 'ui-builder', seat: 'ui-builder' });
  const d = delegate('implementer', 'もう一件');
  applyEvent(s, d);
  assert.equal(d.delegation.seq, 3);
  const sn = snapshot(s);
  assert.deepEqual(Object.keys(sn.delegation).sort(), ['seat', 'seq', 'ts', 'type']);
  assert.equal(sn.delegation.seq, 3);
  assert.ok(!JSON.stringify(sn.delegation).includes('1,234,567'));
  assert.equal(snapshot(createState(roster)).delegation, null);
  // 席が足りない種類でも通し番号は進み、seat は null
  const s2 = createState({ ...roster, members: roster.members.filter((m) => m.seat === 'bucho' || m.type === 'bucho') });
  const e = delegate('implementer', 'x');
  applyEvent(s2, e);
  assert.deepEqual(e.delegation, { seq: 1, type: 'implementer', seat: null });
});

test('サーバー経由でも SSE の delegate イベントに delegation が載る(順序B)', async () => {
  const { startTestServer, openSse } = await import('./helpers.mjs');
  const s = await startTestServer({ port: 0 });
  try {
    const sse = await openSse(s);
    await sse.snapshot();
    const post = (b) => fetch(`http://127.0.0.1:${s.port}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await post({ ts: 1, kind: 'subagent_start', agentId: 'a1', agentType: 'implementer', text: '作業を始めます' });
    await post({ ts: 2, kind: 'delegate', agentId: null, agentType: null, text: 'x', title: '直す', targetType: 'implementer' });
    const o = await sse.office((x) => x.event.kind === 'delegate');
    assert.deepEqual(o.event.delegation, { seq: 1, type: 'implementer', seat: 'implementer' });
    assert.equal(o.snapshot.delegation.seq, 1);
    assert.equal(o.snapshot.members.find((m) => m.seat === 'implementer').count, 1);
    sse.close();
  } finally { await s.close(); }
});
