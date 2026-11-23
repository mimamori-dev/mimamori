import { test } from 'node:test';
import assert from 'node:assert';
import { toOfficeEvent, shorten } from '../lib/describe.mjs';

const base = { session_id: 's', transcript_path: 'T', cwd: 'C' };
const ev = (o, now = 1) => toOfficeEvent({ ...base, ...o }, now);

test('shorten', () => {
  assert.equal(shorten('a\nb', 10), 'a b');
  assert.equal(shorten('abcdef', 3), 'abc…');
  assert.equal(shorten('abc', 3), 'abc');
});

test('UserPromptSubmit -> prompt', () => {
  const prompt = '資料を更新して\n' + 'あ'.repeat(50);
  assert.deepStrictEqual(ev({ hook_event_name: 'UserPromptSubmit', prompt }, 5), {
    ts: 5, kind: 'prompt', agentId: null, agentType: null,
    text: `社長から『${shorten(prompt, 24)}』の指示を受けました`,
    title: shorten(prompt, 40),
    body: prompt,
    transcriptPath: 'T', agentTranscriptPath: null,
  });
  assert.ok(ev({ hook_event_name: 'UserPromptSubmit', prompt }).title.startsWith('資料を更新して あ'));
});

test('Agent/Task -> delegate', () => {
  for (const tool_name of ['Agent', 'Task']) {
    assert.deepStrictEqual(
      ev({ hook_event_name: 'PreToolUse', tool_name, tool_input: { subagent_type: 'report-writer', description: '本編を作る' } }),
      { ts: 1, kind: 'delegate', agentId: null, agentType: null, text: 'report-writerに依頼します',
        title: '本編を作る', targetType: 'report-writer', transcriptPath: 'T', agentTranscriptPath: null });
  }
  const e = ev({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'x' } });
  assert.equal(e.targetType, 'general-purpose');
});

test('SubagentHandback is internal -> null', () => {
  assert.equal(ev({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: {} }), null);
});

test('tools', () => {
  const t = (tool_name, tool_input, extra = {}) =>
    ev({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra });
  const r = t('Read', { file_path: 'C:\\x\\docs\\report.xlsx' }, { agent_id: 'a1', agent_type: 'report-writer' });
  assert.equal(r.kind, 'tool');
  assert.equal(r.text, 'report.xlsxを読んでいます');
  assert.equal(r.agentId, 'a1');
  assert.equal(r.agentType, 'report-writer');
  for (const n of ['Write', 'Edit']) assert.equal(t(n, { file_path: '/a/b/c.md' }).text, 'c.mdを書いています');
  assert.equal(t('NotebookEdit', { notebook_path: 'D:\\n.ipynb' }).text, 'n.ipynbを書いています');
  const cmd = 'x'.repeat(40);
  for (const n of ['Bash', 'PowerShell']) assert.equal(t(n, { command: cmd }).text, 'コマンド実行: ' + 'x'.repeat(30));
  for (const n of ['Grep', 'Glob']) assert.equal(t(n, {}).text, 'ファイルを探しています');
  for (const n of ['WebSearch', 'WebFetch']) assert.equal(t(n, {}).text, 'Webで調べています');
  assert.equal(t('Foo', {}).text, 'Fooを使っています');
});

test('lifecycle events', () => {
  const s = ev({ hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'x' });
  assert.equal(s.kind, 'subagent_start');
  assert.equal(s.agentId, 'a');
  const d = ev({ hook_event_name: 'SubagentStop', agent_id: 'a', agent_type: 'x', agent_transcript_path: 'AT' });
  assert.equal(d.kind, 'subagent_done');
  assert.equal(d.text, 'できました');
  assert.equal(d.agentTranscriptPath, 'AT');
  const pair = (n) => [ev({ hook_event_name: n }).kind, ev({ hook_event_name: n }).text];
  assert.deepStrictEqual(pair('Stop'), ['stop', '社長に報告']);
  assert.deepStrictEqual(pair('Notification'), ['waiting', '社長の確認待ち']);
  assert.deepStrictEqual(pair('SessionStart'), ['session_start', '出社しました']);
});

test('unknown input -> null', () => {
  assert.equal(ev({ hook_event_name: 'Weird' }), null);
  assert.equal(toOfficeEvent(null, 1), null);
  assert.equal(toOfficeEvent({}, 1), null);
});

const askInput = (questions) => ({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions } });

test('AskUserQuestion -> ask(質問を丸めて載せる)', () => {
  const e = ev(askInput([{ question: 'Q'.repeat(300), header: 'H'.repeat(30), multiSelect: true,
    options: [{ label: 'L'.repeat(60), description: 'D'.repeat(200) }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }] }]));
  assert.equal(e.kind, 'ask');
  assert.equal(e.text, '社長のご判断待ち');
  const q = e.questions[0];
  assert.equal(q.question.length, 201);
  assert.equal(q.header.length, 21);
  assert.equal(q.multiSelect, true);
  assert.equal(q.options.length, 4);
  assert.equal(q.options[0].label.length, 41);
  assert.equal(q.options[0].description.length, 121);
  assert.equal(q.options[1].description, '');
});

test('AskUserQuestion の不正入力は例外を出さず、使えない質問を捨てる', () => {
  const bad = [undefined, null, 'x', {}, [], [null, 1, { question: 5 }, { question: '  ' }]];
  for (const questions of bad) assert.equal(ev(askInput(questions)), null);
  assert.equal(toOfficeEvent({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }, 1), null);
  const e = ev(askInput([{ question: 'ok', options: 'x' }, { question: 'ok2', options: [null, { label: 3 }, { label: 'a' }], multiSelect: 'yes' }]));
  assert.equal(e.questions.length, 2);
  assert.deepStrictEqual(e.questions[0].options, []);
  assert.deepStrictEqual(e.questions[1].options, [{ label: 'a', description: '' }]);
  assert.equal(e.questions[1].multiSelect, false);
  const six = Array.from({ length: 6 }, (_, i) => ({ question: `q${i}`, options: [] }));
  assert.equal(ev(askInput(six)).questions.length, 4);
});

test('サブエージェント内の AskUserQuestion は agentId を付けて送る', () => {
  const e = ev({ ...askInput([{ question: 'q', options: [] }]), agent_id: 'a1', agent_type: 'x' });
  assert.equal(e.kind, 'ask');
  assert.equal(e.agentId, 'a1');
});

test('prompt: 吹き出しは先頭24字(超えたら…)、body は300字まで', () => {
  const short = ev({ hook_event_name: 'UserPromptSubmit', prompt: '資料を更新して' });
  assert.equal(short.text, '社長から『資料を更新して』の指示を受けました');
  const long = ev({ hook_event_name: 'UserPromptSubmit', prompt: 'あ'.repeat(400) });
  assert.equal(long.text, `社長から『${'あ'.repeat(24)}…』の指示を受けました`);
  assert.equal(long.body.length, 300);
  assert.equal(long.title.length, 41);
  assert.equal(ev({ hook_event_name: 'UserPromptSubmit', prompt: 5 }).body, '');
});
