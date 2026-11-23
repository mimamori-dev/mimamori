import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, raw } from './helpers.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

// 音声入力はブラウザ認識(Web Speech API)だけ。サーバー側に音声の受け口は無い
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-voice-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');

test('/voice と /voice-warm は無い(GET は 404、POST は 405=未定義の POST)。遠隔からも届かない', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  try {
    for (const p of ['/voice', '/voice-warm']) {
      const r = await raw(s.port, p, { method: 'POST', headers: { 'Content-Type': 'audio/webm', 'Content-Length': '1' }, body: 'a' });
      assert.equal(r.status, 405, p);
      assert.equal((await raw(s.port, p)).status, 404, p);
    }
    const token = 'x'.repeat(24);
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token, allowedHosts: [], port: 0 }), true);
    const r = await raw(s.remotePort(), '/voice', { method: 'POST', headers: { 'Content-Type': 'audio/webm', Cookie: `office_key=${token}`, 'Content-Length': '1' }, body: 'a' });
    assert.ok([403, 404, 405].includes(r.status));
  } finally { await s.close(); }
});

test('画面: 方式の選択欄が無く、録音(/voice)も呼ばない', () => {
  const html = read('index.html'), js = read('office.js');
  assert.ok(!html.includes('ib-vmode'));
  assert.ok(!/<select/.test(html.slice(html.indexOf('id="ib-voice"'), html.indexOf('id="ib-consent"'))));
  assert.ok(!js.includes('/voice') && !js.includes('MediaRecorder'));
});

test('画面: 初回の同意の文言があり、同意は保存される', () => {
  const html = read('index.html'), js = read('office.js');
  assert.ok(html.includes('音声がブラウザの提供元のサーバーに送られます。話す内容にご注意ください'));
  assert.ok(js.includes("lsSet(VM_CONSENT_KEY, '1')"));
  assert.ok(js.includes('if (!voiceConsent) askConsent'));
});

test('画面: 非対応ブラウザではマイクを無効にして案内を出す。エラー理由文は維持', () => {
  const js = read('office.js');
  assert.ok(js.includes('このブラウザは音声認識に対応していません(Chrome または Edge で開いてください)'));
  assert.ok(js.includes('micBtn.disabled = !SpeechRec'));
  for (const k of ['not-allowed', 'service-not-allowed', 'network', 'no-speech', 'audio-capture']) assert.ok(js.includes(k), k);
});

// 音声で止める語句の判定(office.js は three を import するため、関数の本文だけ取り出して評価する)
const stopCheck = (() => {
  const js = read('office.js');
  const a = js.indexOf('const VP ='), b = js.indexOf('// ?voicedebug=1');
  return new Function(`${js.slice(a, b)}; return voiceStopCheck;`)();
})();

test('音声停止語: 末尾の「音声入力終了」は停止し、語句は除く。揺れも許す', () => {
  for (const w of ['音声入力終了', '音声入力 終了', '音声入力、終了', '音声入力　終了', '音声入力。終了。', ' 音声入力 、 終了 ', '音声入力修了', '音声入力 終わり', '音声 入力 終了', '音声入力終了します', 'オンセイニュウリョク終了']) {
    assert.deepEqual(stopCheck(`確認をお願いします${w}`), { stop: true, text: '確認をお願いします' }, w);
  }
  assert.deepEqual(stopCheck('音声入力終了'), { stop: true, text: '' });
});

test('音声停止語: 文中・無関係な文・一部だけでは止めない', () => {
  for (const t of ['音声入力終了について確認して', '音声入力を終了する方法を教えて', '音声入力', '終了', '']) {
    assert.deepEqual(stopCheck(t), { stop: false, text: t }, t);
  }
});

test('画面: 確定結果で判定し、止めたことを表示する。ボタン停止は維持', () => {
  const js = read('office.js');
  assert.ok(js.includes('voiceStopCheck(fin + interim)')); // 確定+仮表示で判定
  assert.ok(js.includes('「音声入力 終了」で録音を止めました'));
  assert.ok(js.includes("else if (micState === 'rec') srStop();"));
});

test('画面: 録音中の「送る」・Enter は録音を止め、仮表示を入力欄へ取り込んでから送る', () => {
  const js = read('office.js');
  const sub = js.slice(js.indexOf('async function ibSubmit'), js.indexOf("ibForm.addEventListener('submit'"));
  assert.ok(sub.indexOf("micState !== 'idle' && srRec") < sub.indexOf('ibText.value'), '録音中の分岐が先');
  assert.ok(sub.includes('srSendAfterStop = true; srStop(true); return;'));
  const end = js.slice(js.indexOf('const finish'), js.indexOf("micSetState('starting')"));
  assert.ok(end.indexOf("fin += interim") < end.indexOf("show('')") && end.indexOf("show('')") < end.indexOf('ibSubmit()'), '仮表示の取り込み→入力欄反映→送信の順');
  assert.ok(js.includes("if (e.key === 'Enter'") && js.includes('ibSubmit(); }'));
});
