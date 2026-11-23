import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createState, applyEvent, snapshot } from '../lib/state.mjs';
import { toOfficeEvent } from '../lib/describe.mjs';

const roster = JSON.parse(readFileSync(new URL('../roster.json', import.meta.url), 'utf8'));
let t = 1000;
const ev = (kind, o = {}) => ({ ts: ++t, kind, agentId: null, agentType: null, text: '', transcriptPath: null, agentTranscriptPath: null, ...o });
const delegate = (type, title) => ev('delegate', { text: `${type}に依頼します`, title, targetType: type });
const start = (id, type) => ev('subagent_start', { agentId: id, agentType: type, text: '作業を始めます' });
const done = (id, type) => ev('subagent_done', { agentId: id, agentType: type, text: 'できました' });
const tool = (name, arg, o = {}) => ev('tool', { toolName: name, toolArg: arg, text: `${name}を使っています`, ...o });
const column = (s, owner) => snapshot(s).board.find((c) => c.owner === owner)?.column;

function finishedWorker(s) {
  applyEvent(s, delegate('implementer', 'サーバー修正'));
  applyEvent(s, start('a1', 'implementer'));
  applyEvent(s, done('a1', 'implementer'));
}

test('完了直後はカードが reviewing へ移るが、部長がまだ何も確認していない間は reviewing は null', () => {
  const s = createState(roster);
  finishedWorker(s);
  assert.equal(column(s, '実装担当'), 'reviewing');
  assert.equal(snapshot(s).reviewing, null);
});

test('担当の完了後に部長が Read すると reviewing に対象・確認者・ファイル名(名前だけ)が入る', () => {
  const s = createState(roster);
  finishedWorker(s);
  applyEvent(s, tool('Read', 'C:\\proj\\office\\lib\\state.mjs'));
  const r = snapshot(s).reviewing;
  assert.equal(r.target, 'タクミくん『サーバー修正』');
  assert.equal(r.by, 'ムサシ部長');
  assert.equal(r.file, 'state.mjs');
  assert.equal(typeof r.since, 'number');
  const c = snapshot(s).board.find((x) => x.owner === '実装担当');
  assert.equal(c.reviewBy, 'ムサシ部長');
  assert.equal(c.reviewFile, 'state.mjs');
  // Bash ではファイルは変えず、since も動かさない
  const since = r.since;
  applyEvent(s, tool('Bash', 'git diff'));
  assert.equal(snapshot(s).reviewing.file, 'state.mjs');
  assert.equal(snapshot(s).reviewing.since, since);
});

test('Write など確認ではないツールではレビュー中にならない', () => {
  const s = createState(roster);
  finishedWorker(s);
  applyEvent(s, tool('Write', 'x.md'));
  assert.equal(snapshot(s).reviewing, null);
});

test('次の SubagentStart で解除(カードは reviewing のまま)、prompt で done', () => {
  const s = createState(roster);
  finishedWorker(s);
  applyEvent(s, tool('Read', 'a.mjs'));
  assert.ok(snapshot(s).reviewing);
  applyEvent(s, delegate('ui-builder', '画面'));
  applyEvent(s, start('a2', 'ui-builder'));
  assert.equal(snapshot(s).reviewing, null);
  assert.equal(column(s, '実装担当'), 'reviewing');
  applyEvent(s, ev('prompt', { text: '次', title: '次' }));
  assert.equal(column(s, '実装担当'), 'done');
  assert.equal(snapshot(s).reviewing, null);
});

test('stop で解除され、reviewing のカードは done になる', () => {
  const s = createState(roster);
  finishedWorker(s);
  applyEvent(s, tool('Grep', ''));
  assert.ok(snapshot(s).reviewing);
  applyEvent(s, ev('stop', { text: '社長に報告' }));
  assert.equal(snapshot(s).reviewing, null);
  assert.equal(column(s, '実装担当'), 'done');
});

test('部長以外(担当)のツールではレビュー開始・更新にならない', () => {
  const s = createState(roster);
  applyEvent(s, delegate('implementer', 'A'));
  applyEvent(s, start('a1', 'implementer'));
  applyEvent(s, delegate('ui-builder', 'B'));
  applyEvent(s, start('a2', 'ui-builder'));
  applyEvent(s, done('a1', 'implementer'));
  applyEvent(s, tool('Read', 'zzz.mjs', { agentId: 'a2', agentType: 'ui-builder' }));
  assert.equal(snapshot(s).reviewing, null);
});

test('qa-tester が動いている間は reviewing(依頼の説明つき)、完了で解除、カードは done', () => {
  const s = createState(roster);
  applyEvent(s, delegate('qa-tester', 'テスト実行'));
  assert.equal(snapshot(s).reviewing, null); // まだ動き出していない
  applyEvent(s, start('q1', 'qa-tester'));
  const r = snapshot(s).reviewing;
  assert.equal(r.target, 'ミルくん『テスト実行』');
  assert.equal(r.by, 'ミルくん');
  assert.equal(r.file, null);
  assert.equal(typeof r.since, 'number');
  applyEvent(s, done('q1', 'qa-tester'));
  assert.equal(snapshot(s).reviewing, null);
  assert.equal(column(s, '動作確認担当'), 'done');
});

test('domain-reviewer・cost-auditor・numbers-checker も動いている間は reviewing', () => {
  for (const [type, nick] of [['domain-reviewer', 'レビューさん'], ['cost-auditor', 'ゼニオくん'], ['numbers-checker', 'カズくん']]) {
    const s = createState(roster);
    applyEvent(s, delegate(type, '確認'));
    applyEvent(s, start('x', type));
    assert.equal(snapshot(s).reviewing.by, nick);
    applyEvent(s, done('x', type));
    assert.equal(snapshot(s).reviewing, null);
  }
});

test('レビュー担当の完了は、部長のレビュー対象にならない', () => {
  const s = createState(roster);
  applyEvent(s, delegate('numbers-checker', '数字確認'));
  applyEvent(s, start('n1', 'numbers-checker'));
  applyEvent(s, done('n1', 'numbers-checker'));
  applyEvent(s, tool('Read', 'r.md'));
  assert.equal(snapshot(s).reviewing, null);
});

test('hook の tool イベントに toolName / toolArg(ファイル名・コマンド先頭80字)が付く', () => {
  const e = toOfficeEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'C:\\a\\b\\c.xlsx' } }, 1);
  assert.equal(e.toolName, 'Read');
  assert.equal(e.toolArg, 'c.xlsx');
  const b = toOfficeEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x'.repeat(200) } }, 1);
  assert.equal(b.toolArg.length, 80);
});

// ---- 活動ログ ----
test('activity: 新しい順で kind/who/text が入り、tool は「Bash: コマンド先頭80字」「Read: ファイル名のみ」', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { text: '社長から『テスト』の指示を受けました', title: 'テスト', body: 'テスト' }));
  applyEvent(s, delegate('implementer', 'サーバー修正'));
  applyEvent(s, start('a1', 'implementer'));
  applyEvent(s, tool('Read', 'C:\\secret\\dir\\data.xlsx', { agentId: 'a1', agentType: 'implementer' }));
  applyEvent(s, tool('Bash', 'echo ' + 'y'.repeat(200), { agentId: 'a1', agentType: 'implementer' }));
  applyEvent(s, done('a1', 'implementer'));
  applyEvent(s, ev('stop', { text: '社長に報告' }));
  const a = snapshot(s, 0, { local: true }).activity;
  assert.deepEqual(a.map((x) => x.kind), ['stop', 'done', 'tool', 'tool', 'delegate', 'prompt']);
  assert.equal(a[0].who, 'ムサシ部長');
  assert.equal(a[1].who, 'タクミくん');
  assert.equal(a[1].text, '『サーバー修正』が完了');
  assert.equal(a[2].text, 'Bash: echo ' + 'y'.repeat(75));
  assert.equal(a[3].text, 'Read: data.xlsx');
  assert.equal(a[3].who, 'タクミくん');
  assert.equal(a[4].text, 'タクミくんに依頼: サーバー修正');
  assert.ok(a.every((x) => [...x.text].length <= 120 && typeof x.ts === 'number'));
});

test('activity: 200件まで、遠隔(local でない)の snapshot には載らない', () => {
  const s = createState(roster);
  for (let i = 0; i < 250; i++) applyEvent(s, tool('Bash', `cmd${i}`));
  const a = snapshot(s, 0, { local: true }).activity;
  assert.equal(a.length, 200);
  assert.equal(a[0].text, 'Bash: cmd249');
  assert.equal('activity' in snapshot(s), false);
  assert.equal('activity' in snapshot(s, 0, { local: false }), false);
});
