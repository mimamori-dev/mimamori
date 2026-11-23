import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createState, applyEvent, snapshot as snap } from '../lib/state.mjs';

// ts は固定の疑似時刻なので、現在時刻でなく最後のイベントの時刻で snapshot を取る(保険の時間切れを誤発火させない)
const snapshot = (s, now = s.lastEventTs) => snap(s, now);
const roster = JSON.parse(readFileSync(new URL('../roster.json', import.meta.url), 'utf8'));
let t = 1000;
const ev = (kind, o = {}) => ({ ts: ++t, kind, agentId: null, agentType: null, text: '', transcriptPath: null, agentTranscriptPath: null, ...o });
const delegate = (type) => ev('delegate', { text: `${type}に依頼します`, title: '依頼', targetType: type });
const start = (id, type) => ev('subagent_start', { agentId: id, agentType: type, text: '開始' });
const sdone = (id, type) => ev('subagent_done', { agentId: id, agentType: type, text: 'できました' });
const istat = (s) => snapshot(s).instructions.map((i) => i.status);
const seat = (s, id) => snapshot(s).members.find((m) => m.seat === id);

function running() {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { title: '指示', body: '実装して', text: '指示を受けました' }));
  applyEvent(s, delegate('implementer'));
  applyEvent(s, start('a1', 'implementer'));
  return s;
}

test('担当が動いている間の部長の stop では、指示も案件も作業中のまま。担当の席は残る', () => {
  const s = running();
  applyEvent(s, ev('stop', { text: '社長に報告' }));
  assert.deepEqual(istat(s), ['working']);
  assert.equal(snapshot(s).instruction.status, 'working');
  assert.ok(snapshot(s).board.some((c) => c.column !== 'done'));
  assert.equal(seat(s, 'implementer').status, 'working');
  assert.equal(seat(s, 'implementer').count, 1);
  assert.equal(seat(s, 'bucho').status, 'idle');
});

test('担当が全員終わって部長が再開→stop で完了(案件も一括 done)', () => {
  const s = running();
  applyEvent(s, ev('stop', { text: '報告' }));
  applyEvent(s, sdone('a1', 'implementer'));
  assert.deepEqual(istat(s), ['working']); // 担当が終わっただけでは、部長の応答が終わるまで作業中
  applyEvent(s, ev('prompt', { body: '<task-notification>done</task-notification>', text: '通知' }));
  assert.deepEqual(istat(s), ['working']);
  applyEvent(s, ev('stop', { text: '報告' }));
  assert.deepEqual(istat(s), ['done']);
  assert.equal(snapshot(s).instruction.status, 'done');
  assert.ok(snapshot(s).board.every((c) => c.column === 'done'));
  assert.ok(snapshot(s).members.every((m) => m.status !== 'working'));
});

test('担当の通知で部長が再開したら、新しい指示は作らず作業中のまま(保留中も)', () => {
  const s = running();
  applyEvent(s, ev('stop', { text: '報告' }));
  applyEvent(s, ev('prompt', { body: '<task-notification>x</task-notification>', text: '通知' }));
  assert.equal(snapshot(s).instructions.length, 1);
  assert.deepEqual(istat(s), ['working']);
  assert.equal(seat(s, 'bucho').status, 'working');
  assert.equal(seat(s, 'implementer').status, 'working');
});

test('社長の新しい指示(通知でない prompt)は、保留中の指示を完了にして新しく始める', () => {
  const s = running();
  applyEvent(s, ev('stop', { text: '報告' }));
  applyEvent(s, ev('prompt', { body: '次の指示', text: '指示' }));
  assert.deepEqual(istat(s), ['done', 'assigning']);
});

test('保険: 保留したまま最後のイベントから30分で完了扱い(時刻は差し替え可)', () => {
  const s = running();
  applyEvent(s, ev('stop', { text: '報告' }));
  const last = s.lastEventTs;
  assert.deepEqual(snapshot(s, last + 29 * 60_000).instructions.map((i) => i.status), ['working']);
  const sn = snapshot(s, last + 30 * 60_000);
  assert.deepEqual(sn.instructions.map((i) => i.status), ['done']);
  assert.ok(sn.board.every((c) => c.column === 'done'));
  assert.equal(sn.members.find((m) => m.seat === 'implementer').status, 'idle');
});

test('保留していなければ時間が経っても何も変わらない', () => {
  const s = createState(roster);
  applyEvent(s, ev('prompt', { body: '指示', text: '指示' }));
  applyEvent(s, ev('tool', { text: 't' }));
  assert.deepEqual(snapshot(s, s.lastEventTs + 99 * 60_000).instructions.map((i) => i.status), ['working']);
});
