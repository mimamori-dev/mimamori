import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/attention.js', import.meta.url), 'utf8');

function boot({ perm = 'granted', noNotification = false } = {}) {
  const els = {};
  const mk = (id) => (els[id] = { id, hidden: false, textContent: '', listeners: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener(t, f) { this.listeners[t] = f; }, querySelector: (s) => els[`${id}${s}`] ?? (els[`${id}${s}`] = { textContent: '' }) });
  ['attn', 'attn-sound', 'attn-notify', 'attn-hint'].forEach(mk);
  const link = { href: 'data:,' };
  const docL = {};
  const document = { documentElement: { classList: { toggle() {} } }, title: 'Mimamori', getElementById: (i) => els[i], querySelector: () => link, addEventListener: (t, f) => { docL[t] = f; } };
  const shown = [];
  const sources = [];
  class ES { constructor() { this.l = {}; sources.push(this); } addEventListener(t, f) { this.l[t] = f; } close() {} }
  class N { constructor(title, o) { this.title = title; this.o = o; shown.push(this); } static permission = perm; static requestPermission = async () => perm; }
  let beeps = 0;
  class AC { constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; } createOscillator() { beeps++; return { frequency: {}, connect() {}, start() {}, stop() {} }; } createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } }
  const timers = [];
  const lst = {};
  const g = { addEventListener: (t, f) => { lst[t] = f; }, document, EventSource: ES, AudioContext: AC, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false }), focus() {}, setTimeout, setInterval: (f) => { timers.push(f); return timers.length; }, clearInterval() {}, encodeURIComponent };
  if (!noNotification) g.Notification = N;
  g.window = g;
  vm.runInNewContext(src, g);
  const push = (snap) => lst['mimamori:snapshot']({ detail: snap });
  return { g, els, document, shown, push, link, beeps: () => beeps, click: () => docL.pointerdown?.(), timers };
}
const dec = (id, header, status = 'pending') => ({ id, header, status });

test('pendingOf: 確認カードと承認待ちの成果物を数える(SNS・承認済みは除く)', () => {
  const { g } = boot();
  const r = g.__attn.pendingOf({ decisions: [dec('d1', 'A'), dec('d2', 'B', 'answered')], deliverables: [{ id: 1, title: 'T', status: 'new' }, { id: 2, status: 'approved' }, { id: 3, status: 'new', sns: true }] });
  assert.equal(r.count, 2);
  assert.equal(r.items.map((i) => i.key).join(','), 'd:d1,v:1');
});

test('新着でタブ題・帯・ファビコン・通知(本文は見出しのみ・長ければ切る)、既存分と同じ件は重複しない', () => {
  const t = boot();
  t.push({ decisions: [dec('d1', '最初')] }); // 初回は通知しない
  assert.equal(t.shown.length, 0);
  assert.equal(t.document.title, '(1)社長の回答待ち - Mimamori');
  assert.equal(t.els.attn.hidden, false);
  assert.ok(t.link.href.startsWith('data:image/svg'));
  t.push({ decisions: [dec('d1', '最初'), dec('d2', 'あ'.repeat(100))] });
  assert.equal(t.shown.length, 1);
  assert.equal(t.shown[0].title, '社長の回答待ち');
  assert.equal(Array.from(t.shown[0].o.body).length, 41);
  t.push({ decisions: [dec('d1', '最初'), dec('d2', 'あ'.repeat(100))] }); // 同じ件
  assert.equal(t.shown.length, 1);
  t.push({ decisions: [] }); // 全部閉じたら元に戻る
  assert.equal(t.document.title, 'Mimamori');
  assert.equal(t.els.attn.hidden, true);
  assert.equal(t.link.href, 'data:,');
});

test('通知が未許可・非対応でも壊れない / 遠隔(canSend:false)は通知も音もなし', () => {
  const a = boot({ perm: 'default' });
  a.push({ decisions: [] }); a.push({ decisions: [dec('d1', 'x')] });
  assert.equal(a.shown.length, 0);
  const b = boot({ noNotification: true });
  b.push({ decisions: [] }); b.push({ decisions: [dec('d1', 'x')] });
  assert.equal(b.document.title, '(1)社長の回答待ち - Mimamori');
  const c = boot();
  c.click();
  c.push({ inbox: { canSend: false }, decisions: [] }); c.push({ inbox: { canSend: false }, decisions: [dec('d1', 'x')] });
  assert.equal(c.shown.length, 0);
  assert.equal(c.beeps(), 0);
  assert.equal(c.document.title, '(1)社長の回答待ち - Mimamori');
});

test('通知音: クリック前は鳴らさず、クリック後は新着の1回(2音)だけ鳴る', () => {
  const t = boot();
  t.push({ decisions: [] });
  t.push({ decisions: [dec('d1', 'x')] });
  assert.equal(t.beeps(), 0);
  t.click();
  t.push({ decisions: [dec('d1', 'x'), dec('d2', 'y')] });
  assert.equal(t.beeps(), 2);
  t.push({ decisions: [dec('d1', 'x'), dec('d2', 'y')] });
  assert.equal(t.beeps(), 2);
});
