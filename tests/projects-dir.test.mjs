import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../office-server.mjs';

async function projectNames(env) {
  const prev = process.env.OFFICE_PROJECTS_DIR;
  if (env === undefined) delete process.env.OFFICE_PROJECTS_DIR; else process.env.OFFICE_PROJECTS_DIR = env;
  const s = await startServer({ port: 0 });
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/projects`);
    return (await r.json()).map((p) => p.name);
  } finally {
    await s.close();
    if (prev === undefined) delete process.env.OFFICE_PROJECTS_DIR; else process.env.OFFICE_PROJECTS_DIR = prev;
  }
}

test('OFFICE_PROJECTS_DIR を指定すると、そのフォルダの名簿が読まれる。未指定なら従来の projects/', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-projects-'));
  try {
    fs.mkdirSync(path.join(dir, 'demo'));
    fs.writeFileSync(path.join(dir, 'demo', 'project.json'), JSON.stringify({ id: 'demo', name: '指定フォルダ版', color: '#fff', root: null }));
    fs.writeFileSync(path.join(dir, 'demo', 'roster.json'), JSON.stringify({ company: 'x', members: [] }));
    assert.deepEqual(await projectNames(dir), ['指定フォルダ版']);
    const dflt = await projectNames(undefined);
    assert.ok(!dflt.includes('指定フォルダ版'));
    assert.ok(dflt.length > 0); // 従来の projects/ の demo などが読まれる
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
