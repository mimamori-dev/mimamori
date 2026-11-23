import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, raw, openSse } from './helpers.mjs';

// 遠隔(スマホ)の口は既定で無効。このファイルは遠隔の動作も確かめるので有効(OFFICE_REMOTE=1)にする
process.env.OFFICE_REMOTE = '1';

const TOKEN = 'test-token-0123456789abcdef';
const post = (port, ev) => raw(port, '/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
const base = { agentId: null, agentType: null, transcriptPath: null, agentTranscriptPath: null };

// 遠隔の /events を1通だけ読む
const remoteSnapshot = (rp) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: rp, path: '/events', headers: { Host: `127.0.0.1:${rp}`, Cookie: `office_key=${TOKEN}` } }, (x) => {
    let buf = '';
    x.on('data', (c) => {
      buf += c;
      const m = /event: snapshot\ndata: (.*)\n\n/.exec(buf);
      if (m) { resolve(JSON.parse(m[1])); r.destroy(); }
    });
  });
  r.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  r.end();
});

test('PC の snapshot には activity と reviewing が載り、遠隔の snapshot には activity が載らない', async () => {
  const s = await startTestServer({ port: 0 });
  try {
    assert.equal(await s.enableRemote({ host: '127.0.0.1', token: TOKEN, port: 0 }), true);
    await post(s.port, { ...base, ts: 1, kind: 'tool', text: 'x', toolName: 'Bash', toolArg: 'git status' });
    const sse = await openSse(s);
    const local = await sse.snapshot();
    assert.equal(local.activity[0].text, 'Bash: git status');
    assert.ok('reviewing' in local);
    sse.close();
    const remote = await remoteSnapshot(s.remotePort());
    assert.equal('activity' in remote, false);
    assert.ok('reviewing' in remote);
    assert.ok(!JSON.stringify(remote).includes('git status'));
  } finally { await s.close(); }
});
