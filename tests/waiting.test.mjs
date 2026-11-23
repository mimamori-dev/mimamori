import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createState, applyEvent, snapshot } from '../lib/state.mjs';
import { toOfficeEvent } from '../lib/describe.mjs';

const roster = JSON.parse(readFileSync(new URL('../roster.json', import.meta.url), 'utf8'));
let t = 1000;
const ev = (kind, o = {}) => ({ ts: ++t, kind, agentId: null, agentType: null, text: '', transcriptPath: null, agentTranscriptPath: null, ...o });
const notify = (message, o = {}) => ev('waiting', { text: '社長の確認待ち', message, ...o });
const start = () => { const s = createState(roster); applyEvent(s, ev('prompt', { text: '指示', title: '指示' })); return s; };
const W = (s, opts) => snapshot(s, Date.now(), opts).waiting;

test('permission: Bash はコマンドの先頭、ファイルはファイル名と種別', () => {
  const s = start();
  applyEvent(s, ev('tool', { toolName: 'Bash', toolArg: 'npm test --silent', text: 'x' }));
  applyEvent(s, notify('Claude needs your permission to use Bash'));
  const w = W(s, { local: true });
  assert.equal(w.kind, 'permission');
  assert.equal(w.text, "Bashコマンド『npm test --silent』の実行許可");
  assert.equal(typeof w.since, 'number');
  applyEvent(s, ev('tool', { toolName: 'Write', toolArg: 'report.md', text: 'x' }));
  applyEvent(s, notify('Claude needs your permission to use Write'));
  assert.equal(W(s, { local: true }).text, "『report.md』の書き込み許可(Write)");
});

test('permission: 長いコマンドは80字まで、本文のツール名が直前と違えば中身を使わない', () => {
  const s = start();
  applyEvent(s, ev('tool', { toolName: 'Bash', toolArg: 'a'.repeat(200), text: 'x' }));
  applyEvent(s, notify('Claude needs your permission to use Bash'));
  assert.ok(W(s, { local: true }).text.includes('a'.repeat(80)));
  assert.ok(!W(s, { local: true }).text.includes('a'.repeat(81)));
  applyEvent(s, notify('Claude needs your permission to use WebFetch'));
  assert.equal(W(s, { local: true }).text, 'WebFetchの使用許可');
  const s2 = start();
  applyEvent(s2, notify('Claude needs your permission'));
  assert.equal(W(s2, { local: true }).text, '操作の許可確認');
});

test('idle / other / 種類不明は推測せず other', () => {
  const s = start();
  applyEvent(s, notify('Claude is waiting for your input'));
  assert.deepEqual([W(s, { local: true }).kind, W(s, { local: true }).text], ['idle', '社長の次の指示待ち']);
  applyEvent(s, notify('Something else happened '.repeat(20)));
  const w = W(s, { local: true });
  assert.equal(w.kind, 'other');
  assert.equal([...w.text].length, 120);
  applyEvent(s, notify(undefined));
  assert.deepEqual([W(s, { local: true }).kind, W(s, { local: true }).text], ['other', '社長の確認待ち']);
  applyEvent(s, notify('x', { notifType: 'idle_prompt' }));
  assert.equal(W(s, { local: true }).kind, 'idle');
});

test('question: decisions の pending が優先、header+質問と選択肢を/でつなぐ。answered で解除', () => {
  const s = start();
  applyEvent(s, notify('Claude needs your permission to use Bash'));
  applyEvent(s, ev('ask', { questions: [{ question: 'どの案にしますか', header: '選択先', options: [{ label: '案A' }, { label: '案B' }], multiSelect: false }] }));
  const w = W(s, { local: true });
  assert.equal(w.kind, 'question');
  assert.equal(w.text, '選択先: どの案にしますか');
  assert.equal(w.detail, '案A/案B');
  assert.equal(snapshot(s, Date.now(), { local: true }).board.find((c) => c.column === 'waiting').waitText, '選択先: どの案にしますか');
  applyEvent(s, ev('tool', { toolName: 'Read', toolArg: 'a.md', text: 'x' }));
  assert.equal(W(s, { local: true }), null);
  assert.ok(!snapshot(s).board.some((c) => 'waitText' in c));
});

test('解除: tool / stop / prompt / subagent_start', () => {
  for (const next of [ev('tool', { toolName: 'Read', toolArg: 'a' }), ev('stop'), ev('prompt', { text: 'p' }), ev('subagent_start', { agentId: 'a1', agentType: 'implementer' })]) {
    const s = start();
    applyEvent(s, notify('Claude needs your permission to use Bash'));
    assert.ok(W(s, { local: true }));
    applyEvent(s, next);
    assert.equal(W(s, { local: true }), null, next.kind);
  }
});

test('遠隔: detail なし・text は種別だけ。カードの waitText も同じ', () => {
  const s = start();
  applyEvent(s, ev('tool', { toolName: 'Bash', toolArg: 'echo 金額1000000', text: 'x' }));
  applyEvent(s, notify('Claude needs your permission to use Bash'));
  const r = W(s, { local: false });
  assert.deepEqual(Object.keys(r).sort(), ['kind', 'since', 'text']);
  assert.equal(r.text, '許可確認待ち');
  const snap = snapshot(s, Date.now(), { local: false });
  assert.equal(snap.board.find((c) => c.column === 'waiting').waitText, '許可確認待ち');
  assert.ok(!JSON.stringify(snap).includes('1000000'));
  assert.equal(snapshot(s, Date.now(), { local: true }).board.find((c) => c.column === 'waiting').waitText, "Bashコマンド『echo 金額1000000』の実行許可");
});

test('不正・欠落入力で落ちない', () => {
  const s = createState(roster);
  for (const m of [null, 5, {}, [], 'x']) applyEvent(s, ev('waiting', { message: m, notifType: m }));
  applyEvent(s, ev('waiting', { ts: undefined }));
  applyEvent(s, ev('tool', { toolName: 5, toolArg: {} }));
  applyEvent(s, notify('Claude needs your permission to use Bash'));
  assert.equal(W(s, { local: true }).kind, 'permission');
  assert.equal(snapshot(createState(roster)).waiting, null);
});

test('hook: Notification の message と種別が event に入る', () => {
  const e = toOfficeEvent({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }, 1);
  assert.equal(e.kind, 'waiting');
  assert.equal(e.text, '社長の確認待ち');
  assert.equal(e.message, 'Claude needs your permission to use Bash');
  assert.equal(e.notifType, 'permission_prompt');
  assert.equal(toOfficeEvent({ hook_event_name: 'Notification' }, 1).message, '');
});
