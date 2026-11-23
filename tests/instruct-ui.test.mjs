import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 遠隔(スマホ)でも指示の入力欄だけは出す(canInstruct)。判断カード等は canSend のまま
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');

test('画面: canInstruct のときだけ指示欄を出し、canSend の判定は変えない', () => {
  const js = read('office.js');
  assert.ok(js.includes("ibInfo.canSend !== true && ibInfo.canInstruct === true"));
  assert.ok(js.includes('const show = pcShow || instrOnly'));
  assert.ok(js.includes("const noSend = mobileMq.matches || ibInfo?.canSend !== true"));
  assert.ok(js.includes("const canClick = mode === 'choice' && !mobileMq.matches && ibInfo?.canSend === true"));
  assert.ok(js.includes("const pcOnly = () => ibInfo?.canSend === true && !mobileMq.matches"));
});

test('画面: 送信は同一オリジンのCookie付き、403/429の分かりやすい文言、二重押し防止', () => {
  const js = read('office.js');
  assert.ok(js.includes("credentials: 'same-origin'"));
  assert.ok(js.includes('合言葉が切れました。PCのQRを読み取り直してください'));
  assert.ok(js.includes("r.headers.get('Retry-After')"));
  assert.ok(js.includes('if (ibBusy || micState'));
});

test('画面: スマホ幅の指示欄は16px以上・44px以上の送るボタン、音声は未対応の一行', () => {
  const css = read('style.css'), html = read('index.html');
  assert.match(css, /#inbox\.instr-only #ib-text \{ font-size: 16px/);
  assert.match(css, /#inbox\.instr-only #ib-send \{[^}]*min-height: 44px/);
  assert.ok(html.includes('スマホの音声は未対応(キーボードのマイクを使ってください)'));
});

test('画面: 遠隔が無効(/remote-info が 404)なら、PC の画面で OFFICE_REMOTE=1 の案内を出す', () => {
  const js = read('office.js'), html = read('index.html'), css = read('style.css');
  assert.ok(js.includes('r.status === 404'));
  assert.ok(js.includes("$('#phone-off').hidden = false"));
  assert.match(html, /id="phone-off"[^>]*hidden>[^<]*環境変数 OFFICE_REMOTE=1 で有効にできます/);
  assert.ok(css.includes('#phone [hidden] { display: none; }'));
});
