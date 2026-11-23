import fs from 'node:fs';
import path from 'node:path';

// SNS用の成果物カードの保存(office/data/sns-queue.json)。投稿済みかどうかを再起動で失わないための最小限。
// 保存するのは id・題・一言・パス・投稿文・状態・投稿日時などだけ(金額・個人情報は入れない)。プロジェクト id ごとに分ける。
// 読み書きの失敗は呼び出し側が受けて画面に出す(例外はここでは握りつぶさない)。
export const SNS_FIELDS = ['id', 'title', 'note', 'path', 'fileName', 'kind', 'postText', 'posted', 'postedAt', 'createdAt'];

function readAll(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { projects: {} }; throw e; }
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object' || typeof j.projects !== 'object' || j.projects === null || Array.isArray(j.projects)) throw new Error('形式が不正です');
  return j;
}

export function loadSns(file, projectId) {
  if (!file) return [];
  const list = readAll(file).projects[projectId];
  return Array.isArray(list) ? list.filter((x) => x && typeof x.id === 'string' && typeof x.path === 'string') : [];
}

// 同期で、他プロジェクトの分を残して書き換える。途中で壊れないよう一時ファイル経由
export function saveSns(file, projectId, items) {
  if (!file) return;
  let all;
  try { all = readAll(file); } catch { all = { projects: {} }; } // 壊れていたら、このプロジェクトの分から作り直す
  all.projects[projectId] = items.map((d) => Object.fromEntries(SNS_FIELDS.map((k) => [k, d[k] ?? null])));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}
