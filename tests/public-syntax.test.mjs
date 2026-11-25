import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 画面の JS は他のテストで読み込まれない。文法エラーが1つあると3Dオフィスごと描画されなくなるので、文法だけ検査する
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

for (const name of fs.readdirSync(pub).filter((n) => n.endsWith('.js'))) {
  test(`public/${name} は文法エラーがない`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-syntax-'));
    try {
      const copy = path.join(dir, 'check.mjs'); // import / export を含むので ES モジュールとして検査する
      fs.copyFileSync(path.join(pub, name), copy);
      const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
