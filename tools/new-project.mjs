// projects/_template から projects/<id> を作る。使い方: node tools/new-project.mjs <id>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_RE } from '../lib/projects.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createProject(id, projectsDir = path.join(here, '..', 'projects')) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('id は小文字英字で始まり、小文字英数字・_・- のみ、32文字以内にしてください(例: my-app)');
  const tpl = path.join(projectsDir, '_template');
  if (!fs.existsSync(path.join(tpl, 'project.json'))) throw new Error(`ひな形がありません: ${tpl}`);
  const dest = path.join(projectsDir, id);
  if (fs.existsSync(dest)) throw new Error(`すでにあります: ${dest}`);
  fs.mkdirSync(dest);
  const meta = JSON.parse(fs.readFileSync(path.join(tpl, 'project.json'), 'utf8'));
  fs.writeFileSync(path.join(dest, 'project.json'), JSON.stringify({ ...meta, id, name: id }, null, 2) + '\n');
  fs.copyFileSync(path.join(tpl, 'roster.json'), path.join(dest, 'roster.json'));
  return dest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const dest = createProject(process.argv[2]);
    console.log(`作りました: ${dest}\nproject.json の name・color・root と、roster.json の名簿を編集してください。`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
