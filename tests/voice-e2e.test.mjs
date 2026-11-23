import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startTestServer } from './helpers.mjs';

// 実ページ(ヘッドレス Chrome)+ SpeechRecognition の差し替えモックで、録音中の「送る」「Enter」「音声入力 終了」を確かめる。
// Chrome が無ければ skip。Chrome の --remote-debugging-port と Node 標準の WebSocket だけを使う(追加パッケージ無し)。
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.CHROME_PATH].find((p) => p && fs.existsSync(p));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-voice-e2e-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本物の Chrome と同じ順序: start直後にonstart / stop()後に未確定が確定して届きonend / abortはonendのみ
const MOCK = `(() => {
  window.__mockOpts = { noEndAfterStop: false, finalizeOnStop: true, errorOnStop: null };
  window.__recs = [];
  class SR {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = ''; this._on = false; this._i = null; this._f = []; window.__recs.push(this); window.__rec = this; }
    start() { if (this._on) throw new Error('InvalidStateError'); this._on = true; setTimeout(() => this.onstart && this.onstart({}), 0); }
    _emit(resultIndex) {
      const results = this._f.map((t) => Object.assign([{ transcript: t }], { isFinal: true }));
      if (this._i != null) results.push(Object.assign([{ transcript: this._i }], { isFinal: false }));
      this.onresult && this.onresult({ resultIndex, results });
    }
    say(t) { this._i = t; this._emit(this._f.length); }                 // 仮表示
    finalize() { const t = this._i; this._i = null; this._f.push(t); this._emit(this._f.length - 1); } // 確定
    sayFinal(t) { this._i = t; this.finalize(); }
    stop() {
      if (!this._on) return;
      const o = window.__mockOpts;
      if (o.noEndAfterStop) return;
      setTimeout(() => {
        if (o.finalizeOnStop && this._i != null) this.finalize();
        if (o.errorOnStop) this.onerror && this.onerror({ error: o.errorOnStop });
        this._on = false; this.onend && this.onend({});
      }, 30);
    }
    abort() { if (!this._on) return; setTimeout(() => { this._on = false; this.onerror && this.onerror({ error: 'aborted' }); this.onend && this.onend({}); }, 10); }
    fail(error) { setTimeout(() => { this.onerror && this.onerror({ error }); this._on = false; this.onend && this.onend({}); }, 0); }
  }
  window.SpeechRecognition = SR; window.webkitSpeechRecognition = SR;
  try { localStorage.setItem('office.voiceBrowserConsent', '1'); } catch {}
  window.__posts = [];
  const of = window.fetch.bind(window);
  window.fetch = (u, o) => { if (String(u).includes('/instruction') && o && o.method === 'POST') window.__posts.push(JSON.parse(o.body).text); return of(u, o); };
})();`;

async function withPage(width, fn, query = '') {
  const s = await startTestServer({ port: 0, allowedRoot: dir });
  const port = 9300 + Math.floor(Math.random() * 500);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'office-voice-chrome-'));
  const ch = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, `--window-size=${width},900`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  try {
    let list;
    for (let i = 0; i < 60; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (list.some((t) => t.type === 'page')) break; } catch { /* 起動待ち */ } await sleep(250); }
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
    await send('Page.navigate', { url: `http://127.0.0.1:${s.port}/${query}` });
    for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector('#ib-mic') && !document.querySelector('#ib-mic').hidden`)) break; await sleep(250); }
    const api = {
      ev, send,
      state: () => ev(`({ rec: document.querySelector('#ib-mic').classList.contains('rec'), text: document.querySelector('#ib-text').value, posts: window.__posts.slice(), err: document.querySelector('#ib-error').textContent, sendDisabled: document.querySelector('#ib-send').disabled })`),
      mic: () => ev(`document.querySelector('#ib-mic').click()`),
      // 実際のマウスクリック(上に別要素が重なっていれば届かない)
      clickReal: async (sel) => {
        const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); const x = b.x + b.width / 2, y = b.y + b.height / 2; const t = document.elementFromPoint(x, y); return { x, y, hit: t && (t.id || t.tagName), ok: !!t && !!t.closest(${JSON.stringify(sel)}) }; })()`);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        return r;
      },
      key: async (key, code, vk) => { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, ...(type === 'rawKeyDown' ? { text: '\r' } : {}) }); },
      reset: () => ev(`(() => { window.__posts.length = 0; window.__mockOpts.noEndAfterStop = false; window.__mockOpts.errorOnStop = null; window.__mockOpts.finalizeOnStop = true; document.querySelector('#ib-text').value = ''; })()`),
      waitFor: async (cond, ms = 4000) => { const t = Date.now(); for (;;) { const st = await api.state(); if (cond(st)) return st; if (Date.now() - t > ms) return st; await sleep(50); } },
    };
    await fn(api);
  } finally {
    try { ch.kill(); } catch { /* ignore */ }
    await s.close();
    await sleep(300);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* Chrome のロック解放待ち。残っても一時フォルダ */ }
  }
}

const opts = { skip: !process.env.VOICE_E2E ? '実Chromeを使う重い検証。VOICE_E2E=1 で実行' : (CHROME ? false : 'Chrome が見つからない'), timeout: 90000 };

for (const width of [1920, 1280]) {
  test(`録音中の送る/Enter/音声入力 終了(実ページ ${width}幅)`, opts, async () => {
    await withPage(width, async (p) => {
      // (a) 録音中に「送る」を実クリック: 仮表示の文字を取り込んで送信
      await p.mic(); await p.waitFor((s) => s.rec);
      await p.ev(`window.__rec.say('テスト')`);
      assert.equal((await p.state()).text, 'テスト');
      const hit = await p.clickReal('#ib-send');
      assert.ok(hit.ok, `送るボタンの上に別要素: ${hit.hit}`);
      let s = await p.waitFor((x) => x.posts.length > 0);
      assert.deepEqual(s.posts, ['テスト'], JSON.stringify(s));
      assert.equal(s.rec, false);

      // (b) 録音中に Enter
      await p.reset(); await p.mic(); await p.waitFor((x) => x.rec);
      await p.ev(`window.__rec.say('エンター'); document.querySelector('#ib-text').focus()`);
      await p.key('Enter', 'Enter', 13);
      s = await p.waitFor((x) => x.posts.length > 0);
      assert.deepEqual(s.posts, ['エンター'], JSON.stringify(s));

      // (c) 確定結果の末尾が「音声入力 終了」: 止まり、語句は入らない、送信はしない
      await p.reset(); await p.mic(); await p.waitFor((x) => x.rec);
      await p.ev(`window.__rec.sayFinal('こんにちは 音声入力 終了')`);
      s = await p.waitFor((x) => !x.rec);
      assert.equal(s.rec, false); assert.equal(s.text, 'こんにちは'); assert.deepEqual(s.posts, []);

      // (d) 仮表示の時点で「音声入力 終了」: 止まる(確定が来なくても)。stop後に確定が来ても語句は入らない
      await p.reset(); await p.mic(); await p.waitFor((x) => x.rec);
      await p.ev(`window.__rec.say('おはよう 音声入力 終了')`);
      s = await p.waitFor((x) => !x.rec);
      assert.equal(s.rec, false); assert.equal(s.text, 'おはよう'); assert.deepEqual(s.posts, []);

      // 文中に出ただけなら止めない
      await p.reset(); await p.mic(); await p.waitFor((x) => x.rec);
      await p.ev(`window.__rec.say('音声入力 終了について教えて')`);
      await sleep(200);
      s = await p.state(); assert.equal(s.rec, true); assert.equal(s.text, '音声入力 終了について教えて');
      await p.ev(`window.__rec.sayFinal('音声入力 終了について教えて')`); await sleep(100);
      assert.equal((await p.state()).rec, true);
      await p.mic(); await p.waitFor((x) => !x.rec);

      // (e1) stop() の後に onend が来ない: 一定時間後に強制的に送信処理へ進む
      await p.reset(); await p.ev(`window.__mockOpts.noEndAfterStop = true`);
      await p.mic(); await p.waitFor((x) => x.rec);
      await p.ev(`window.__rec.say('終了来ない')`);
      await p.clickReal('#ib-send');
      s = await p.waitFor((x) => x.posts.length > 0, 5000);
      assert.deepEqual(s.posts, ['終了来ない'], JSON.stringify(s));
      assert.equal(s.rec, false);
      await p.ev(`window.__rec.onend = null`); // 古い録音の遅れた onend が次を壊さない確認用に切り離し

      // (e2) onerror(no-speech)後の onend で、送信待ちがあっても文字があれば送る
      await p.reset(); await p.mic(); await p.waitFor((x) => x.rec);
      await p.ev(`window.__mockOpts.errorOnStop = 'no-speech'; window.__rec.say('エラー付き')`);
      await p.clickReal('#ib-send');
      s = await p.waitFor((x) => x.posts.length > 0);
      assert.deepEqual(s.posts, ['エラー付き'], JSON.stringify(s));

      // 何も話さずに録音中に「送る」: 空は送らず、止まる
      await p.reset(); await p.mic(); await p.waitFor((x) => x.rec);
      await p.clickReal('#ib-send');
      s = await p.waitFor((x) => !x.rec);
      assert.equal(s.rec, false); assert.deepEqual(s.posts, []);
    });
  });
}

test('録音中の送るボタンが押せる(500幅=スマホはマイクなし、1280/1920は上に別要素なし)', opts, async () => {
  await withPage(1280, async (p) => {
    await p.mic(); await p.waitFor((x) => x.rec);
    await p.ev(`window.__rec.say('x')`);
    const st = await p.state();
    assert.equal(st.sendDisabled, false);
    const hit = await p.clickReal('#ib-send'); assert.ok(hit.ok, hit.hit);
    const hit2 = await p.ev(`(() => { const b = document.querySelector('#ib-mic').getBoundingClientRect(); const t = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!t.closest('#ib-mic'); })()`);
    assert.equal(hit2, true);
  });
});

test('終了語の表記ゆれ・onend無し・pointerdownだけで送信(実ページ)', opts, async () => {
  await withPage(1280, async (p) => {
    const stopCases = [['やあ 音声入力終了', 'やあ'], ['やあ 音声入力、終了。', 'やあ'], ['やあ 音声入力 修了', 'やあ'], ['やあ 音声入力 終わり', 'やあ'], ['やあ 音声 入力 終了', 'やあ'], ['やあ 音声入力終了します', 'やあ'], ['やあ オンセイニュウリョク シュウリョウ', 'やあ']];
    for (const [say, want] of stopCases) {
      for (const how of ['say', 'sayFinal']) {
        await p.reset(); await p.mic(); await p.waitFor((x) => x.rec);
        await p.ev(`window.__rec.${how}(${JSON.stringify(say)})`);
        const s = await p.waitFor((x) => !x.rec);
        assert.equal(s.rec, false, `${how}: ${say}`); assert.equal(s.text, want, `${how}: ${say}`); assert.deepEqual(s.posts, []);
      }
    }
    // 確定済み+続けて仮表示で終了語(複数結果にまたがる)
    await p.reset(); await p.mic(); await p.waitFor((x) => x.rec);
    await p.ev(`window.__rec.sayFinal('一つ目'); window.__rec.say('二つ目 音声入力 終了')`);
    let s = await p.waitFor((x) => !x.rec);
    assert.equal(s.text, '一つ目二つ目');
    // 終了語で止めたが onend が来ない: 約1秒で強制終了
    await p.reset(); await p.ev(`window.__mockOpts.noEndAfterStop = true`); await p.mic(); await p.waitFor((x) => x.rec);
    await p.ev(`window.__rec.say('末尾 音声入力 終了')`);
    s = await p.waitFor((x) => !x.rec, 3000);
    assert.equal(s.rec, false); assert.equal(s.text, '末尾'); assert.deepEqual(s.posts, []);
    await p.ev(`window.__rec.onend = null`);
    // 押した瞬間(mousePressed のみ、離さない)で止まって送信
    await p.reset(); await p.mic(); await p.waitFor((x) => x.rec);
    await p.ev(`window.__rec.say('押下だけ')`);
    const r = await p.ev(`(() => { const b = document.querySelector('#ib-send').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    s = await p.waitFor((x) => x.posts.length > 0, 1500);
    assert.deepEqual(s.posts, ['押下だけ'], JSON.stringify(s)); assert.equal(s.rec, false);
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(200);
    assert.deepEqual((await p.state()).posts, ['押下だけ']); // クリックで二重送信しない
  });
});

test('?voicedebug=1 のときだけ診断表示が出る', opts, async () => {
  await withPage(1280, async (p) => {
    await p.mic(); await p.waitFor((x) => x.rec);
    await p.ev(`window.__rec.say('診断')`);
    const t = await p.ev(`document.querySelector('#ib-vdebug')?.textContent ?? ''`);
    assert.match(t, /start/); assert.match(t, /診断/);
  }, '?voicedebug=1');
  await withPage(1280, async (p) => {
    await p.mic(); await p.waitFor((x) => x.rec);
    assert.equal(await p.ev(`!!document.querySelector('#ib-vdebug')`), false);
  });
});
