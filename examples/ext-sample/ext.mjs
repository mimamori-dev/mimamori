// 汎用のサンプル拡張。OFFICE_EXT_DIR にこのフォルダを指定して起動する
import fs from 'node:fs';
import path from 'node:path';

export default {
  routes: {
    // 読み取り経路
    'GET /ext/hello': (req, res, ctx) => ctx.json(res, 200, { hello: 'world', project: ctx.info.id }),
    // 小さな JSON を受け取り、dataDir に保存する
    'POST /ext/note': (req, res, ctx) => ctx.readSmallJson(req, res, 4096, (body) => {
      // readSmallJson は他サイト由来を既に断る。独自に読む経路では ctx.crossSite(req) を使う
      // ctx.validOtherText(text, max) で自由入力を検証、ctx.openGate() で「開く」操作の連打を抑える
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      fs.writeFileSync(path.join(ctx.dataDir, 'note.json'), JSON.stringify({ text: String(body.text ?? ''), at: ctx.now() }));
      ctx.json(res, 200, { ok: true });
    }),
  },
  // スマホ遠隔で通してよい経路。書かなければ拡張の経路は全て 403(安全側)
  remoteAllowed: ['GET /ext/hello'],
  panelsJs: true, // public/panels.js を /ext/panels.js として配信
  panelsCss: true, // public/panels.css を /ext/panels.css として配信
};
