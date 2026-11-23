import fs from 'node:fs/promises';
import path from 'node:path';

const ZERO = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

function inside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 最長一致: "claude-x-5" が "claude-x-5-1" の単価を奪わないようにする
function findPrice(pricing, model) {
  let best = null;
  for (const key of Object.keys(pricing?.models ?? {})) {
    if (model.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  return best === null ? null : pricing.models[best];
}

export function createUsageMeter({ pricing, allowedRoot }) {
  const root = path.resolve(allowedRoot);
  const files = new Map(); // path -> 読み取り済みバイト位置
  const entries = new Map(); // `${path}\0${id}` -> { seat, model, usage, base }
  let skippedFiles = 0;

  function ingest(text, filePath, seat) {
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      let o;
      try { o = JSON.parse(raw); } catch { continue; }
      const m = o?.type === 'assistant' ? o.message : null;
      const u = m?.usage;
      if (!u || typeof m.id !== 'string') continue;
      const usage = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      };
      const key = `${filePath}\0${m.id}`;
      const prev = entries.get(key);
      entries.set(key, { seat, model: String(m.model ?? ''), usage, base: prev?.base ?? ZERO() });
    }
  }

  async function track(p, seat) {
    const abs = path.resolve(String(p));
    if (path.extname(abs) !== '.jsonl' || !inside(root, abs)) return;
    let fh;
    try {
      fh = await fs.open(abs, 'r');
      const { size } = await fh.stat();
      let pos = files.get(abs) ?? 0;
      if (size < pos) pos = 0; // 切り詰められたら先頭から読み直す
      if (size === pos) { files.set(abs, pos); return; }
      const buf = Buffer.alloc(size - pos);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      const chunk = buf.subarray(0, bytesRead);
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl < 0) return; // 書きかけの1行だけ: 次回に回す
      ingest(chunk.subarray(0, lastNl).toString('utf8'), abs, seat);
      files.set(abs, pos + lastNl + 1);
    } catch {
      skippedFiles++;
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  function resetTurn() {
    // 同じidが後から伸びても増分だけ数えるため、現在値を基準として覚える
    for (const e of entries.values()) e.base = { ...e.usage };
  }

  function totals() {
    const tokens = ZERO();
    const bySeat = {};
    const unpriced = new Set();
    let usd = 0;
    for (const e of entries.values()) {
      const d = {};
      let sum = 0;
      for (const k of Object.keys(tokens)) { d[k] = e.usage[k] - e.base[k]; sum += d[k]; }
      if (sum === 0) continue;
      for (const k of Object.keys(tokens)) tokens[k] += d[k];
      bySeat[e.seat] = (bySeat[e.seat] ?? 0) + sum;
      const price = findPrice(pricing, e.model);
      if (!price) { unpriced.add(e.model); continue; }
      usd += (d.input * price.input + d.output * price.output + d.cacheWrite * price.cacheWrite + d.cacheRead * price.cacheRead) / 1e6;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead;
    const priced = pricing && typeof pricing.usdJpy === 'number';
    return {
      tokens,
      usd: pricing ? usd : null,
      jpy: priced ? usd * pricing.usdJpy : null,
      unpricedModels: [...unpriced],
      bySeat,
      skippedFiles,
    };
  }

  return { track, resetTurn, totals };
}
