# プロジェクトのひな形

`npm run new-project -- <id>` でこのフォルダの `project.json` と `roster.json` を `projects/<id>/` にコピーします。`_` で始まるこのフォルダ自体はプロジェクトとして読み込まれません。

## project.json

JSON はコメントを書けないので、各項目の意味はここに書きます。

- `id`: フォルダ名と同じにする(コマンドが自動で入れます)。小文字英字で始まり、小文字英数字・`_`・`-`、32文字以内
- `name`: 画面に出る名前
- `color`: 表示の色(例 `#8fc7e8`)
- `root`: ファイル一覧・成果物登録の基準フォルダ。`project.json` からの相対パスか絶対パス。`null` なら未設定。hook を受けたとき、作業フォルダがこの下にあるプロジェクトに振り分けます

## roster.json

- `company`: 名簿の見出し
- `members`: 席に座る人の配列。各要素は `type`(担当の種類。Claude Code のサブエージェント名と同じにすると席が結び付く。部長は `bucho`)・`nickname`・`name`・`dept`・`color`
- 同梱の `projects/demo/roster.json` を見本にしてください

壊れた JSON や規則違反があると、起動時と `npm run doctor` に理由つきの警告が出ます。
