import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, raw } from './helpers.mjs';
import { speechText } from '../public/speech-text.js';

process.env.OFFICE_REMOTE = '1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-tts-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const J = { 'Content-Type': 'application/json' };
const post = (s, body, headers = {}) => raw(s.port, '/tts', { method: 'POST', headers: { ...J, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('speechText: コード・URL・表・長い数字・絵文字・記号を読まない', () => {
  const t = speechText('# 見出し\n**太字**です https://example.com/a?b=1 と `code` 😀\n| a | b |\n|---|---|\n| 1 | 2 |\n番号 1234567890 と 12,345 円\n```js\nx=1\n```\nおわり');
  assert.equal(t, '見出し。太字です と。番号 と 12,345 円。おわり');
  assert.ok(!/https?|code|😀|\|/.test(t));
});

test('speechText: 300字に切る・空や記号だけは空文字・非文字列も安全', () => {
  assert.ok(speechText('あ'.repeat(1000)).length <= 300);
  const long = `${'あいう。'.repeat(120)}`;
  assert.ok(speechText(long).endsWith('。') && speechText(long).length <= 300);
  assert.equal(speechText('😀😀'), '');
  assert.equal(speechText('   \n  '), '');
  assert.equal(speechText(null), '');
  assert.equal(speechText(undefined), '');
  assert.equal(speechText({}), '');
  assert.equal(speechText('C:\\Users\\x\\a.txt を見て'), 'を見て');
});

test('/tts: VOICEVOX が無ければ 503', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir, voicevoxUrl: 'http://127.0.0.1:9', ttsTimeoutMs: 1500 });
  try { assert.equal((await post(s, { text: 'こんにちは' })).status, 503); } finally { await s.close(); }
});

test('/tts: 他サイト・遠隔は 403、長文は 413、不正は 400/415', async () => {
  const s = await startTestServer({ port: 0, allowedRoot: dir, voicevoxUrl: 'http://127.0.0.1:9', ttsTimeoutMs: 1500 });
  try {
    assert.equal((await post(s, { text: 'a' }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(s, { text: 'a' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post(s, { text: 'あ'.repeat(401) })).status, 413);
    assert.equal((await post(s, { text: '' })).status, 400);
    assert.equal((await post(s, { text: 'a', speaker: 'x' })).status, 400);
    assert.equal((await post(s, 'not json')).status, 400);
    assert.equal((await raw(s.port, '/tts', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'a' })).status, 415);
    assert.equal((await raw(s.port, '/tts', { method: 'POST', headers: { Host: 'evil.example', ...J }, body: '{"text":"a"}' })).status, 403);
    const token = 'y'.repeat(24);
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token, allowedHosts: [], port: 0 }), true);
    const r = await raw(s.remotePort(), '/tts', { method: 'POST', headers: { ...J, Cookie: `office_key=${token}`, Host: `127.0.0.1:${s.remotePort()}` }, body: '{"text":"a"}' });
    assert.equal(r.status, 403);
  } finally { await s.close(); }
});

test('/tts: VOICEVOX(模擬)があれば wav を返し、話者IDを渡す', async () => {
  const seen = [];
  const mock = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(`${u.pathname}?speaker=${u.searchParams.get('speaker')}`);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (u.pathname === '/audio_query') { res.writeHead(200, J); res.end('{"q":1}'); }
      else if (u.pathname === '/synthesis') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(Buffer.from('RIFFxxxxWAVE')); }
      else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const s = await startTestServer({ port: 0, allowedRoot: dir, voicevoxUrl: `http://127.0.0.1:${mock.address().port}` });
  try {
    const r = await post(s, { text: 'こんにちは', speaker: 3 });
    assert.equal(r.status, 200);
    assert.ok(r.text.startsWith('RIFF'));
    assert.deepEqual(seen, ['/audio_query?speaker=3', '/synthesis?speaker=3']);
  } finally { await s.close(); mock.close(); }
});

test('VOICEVOX の宛先は同じPCだけ', async () => {
  const { createTts } = await import('../lib/tts.mjs');
  assert.throws(() => createTts({ baseUrl: 'http://example.com:50021' }));
});

test('画面: 既定OFF・スイッチと設定・クレジット欄があり、外部URLを持たない', () => {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(pub, 'speech.js'), 'utf8');
  assert.ok(html.includes('id="tts-sw"') && html.includes('aria-checked="false"') && html.includes('>OFF<'));
  assert.ok(html.includes('id="tts-credit"') && html.includes('/static/speech.js'));
  assert.ok(!/https?:\/\//.test(js));
  assert.ok(js.includes("fetch('/tts'") && js.includes('if (!isRemote)'));
});
