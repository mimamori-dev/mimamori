import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createState, applyEvent, snapshot, subject } from '../lib/state.mjs';
import { toOfficeEvent } from '../lib/describe.mjs';

const roster = JSON.parse(readFileSync(new URL('../roster.json', import.meta.url), 'utf8'));
let t = 1000;
const ev = (kind, o = {}) => ({ ts: ++t, kind, agentId: null, agentType: null, text: '', transcriptPath: null, agentTranscriptPath: null, ...o });
const board = (s) => snapshot(s).board;
const nameOf = (type) => roster.members.find((m) => (m.types ?? [m.type]).includes(type)).name;

test('subject: 最初の空でない1行を40字まで。空・不正は空文字', () => {
  assert.equal(subject('\n  \n  一行目です  \n二行目'), '一行目です');
  assert.equal(subject('あ'.repeat(50)).length, 40);
  for (const v of [undefined, null, '', '   \n ', 5, {}]) assert.equal(typeof subject(v), 'string');
  assert.equal(subject(undefined), '');
});

test('部長の案件: 件名が無くても指示本文の先頭1行になり、本文も無ければ「社長の指示」', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { text: 'p', body: '\n決算を見直して\n詳しくは…' }));
  assert.equal(board(s).at(-1).title, '決算を見直して');
  applyEvent(s, ev('prompt', { text: 'p', title: '明示の件名', body: '本文' }));
  assert.equal(board(s).at(-1).title, '明示の件名');
  applyEvent(s, ev('prompt', { text: 'p', title: '   ' }));
  assert.equal(board(s).at(-1).title, '社長の指示');
  assert.ok(board(s).every((c) => c.title && !c.title.includes('件名なし')));
});

test('委任: description が無ければ依頼本文の先頭、どちらも無ければ「担当名への依頼」。担当の作業カードは委任の件名を引き継ぐ', () => {
  const s = createState(roster);
  applyEvent(s, ev('delegate', { targetType: 'implementer', title: undefined, body: '\n\nサーバーを直す\n詳細' }));
  applyEvent(s, ev('subagent_start', { agentId: 'a1', agentType: 'implementer' }));
  const c1 = board(s).find((c) => c.owner === nameOf('implementer'));
  assert.equal(c1.title, 'サーバーを直す');
  applyEvent(s, ev('delegate', { targetType: 'qa-tester' }));
  const c2 = board(s).find((c) => c.owner === nameOf('qa-tester'));
  assert.equal(c2.title, `${nameOf('qa-tester')}への依頼`);
  assert.ok(board(s).every((c) => c.title.trim()));
});

test('委任の記録なしで担当が動き出した場合は「担当名の作業」(件名なしにしない)', () => {
  const s = createState(roster);
  applyEvent(s, ev('subagent_start', { agentId: 'z1', agentType: 'ui-builder' }));
  applyEvent(s, ev('tool', { agentId: 'z1', agentType: 'ui-builder', text: 'x', toolName: 'Read', toolArg: 'a' }));
  const c = board(s).find((x) => x.owner === nameOf('ui-builder'));
  assert.equal(c.title, `${nameOf('ui-builder')}の作業`);
});

test('hook: Agent の入力に description が無くても prompt が body に入り、件名の元になる', () => {
  const e = toOfficeEvent({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'implementer', prompt: '画面を直す\n詳細' } }, 1);
  assert.equal(e.kind, 'delegate');
  assert.equal(e.title, undefined);
  const s = createState(roster);
  applyEvent(s, e);
  assert.equal(board(s).at(-1).title, '画面を直す');
  const e2 = toOfficeEvent({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'implementer', description: '依頼の件名', prompt: '本文' } }, 1);
  assert.equal(e2.title, '依頼の件名');
});
