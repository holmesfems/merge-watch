# merge-watch

Claude Code のセッションが出した GitHub の PR を見張り、**マージされたら、そのセッションを起こして後始末をさせる** mod です。

デスクトップアプリの PR の Auto-fix は、CI の失敗・コンフリクト・レビューのコメントでセッションを起こしますが、マージでは起こしません。merge-watch はその穴をうめます。PR をマージしたら、そのまま Claude が main に切り替えて pull し、マージ済みのブランチを片付けてくれます。

## しくみ

- **見張る PR**：そのセッションで `gh pr create` を動かして出した PR と、デスクトップアプリで bind した PR（`mcp__ccd_pr__bind_pr`）を自動で覚えます。`/merge-watch <URL>` で手で足すこともできます。
- **見に行く**：数分おき（既定は 5 分）に `gh pr view <URL> --json state,…` を動かします。`gh` の認証をそのまま使うので、トークンを書き出したり置いたりはしません。1 件につき 1 回ずつなので、5 分おきなら 1 時間に 12 回で、GitHub API の上限（1 時間 5,000 回）よりずっと少ない回数です。
- **マージされたら**：その PR の見張りをやめ、セッションに「PR がマージされたので後始末を」というメッセージを送ります（merge-watch からのメッセージとして届き、ユーザーが打った言葉にはなりません）。セッションがひまならすぐに、作業中ならそのターンが終わってから始まります。
- **閉じられたら**：マージされずに閉じた PR は、知らせを 1 行残して見張りをやめます。`gh` が続けて 6 回失敗した PR（消された・見えなくなった、など）も見張りをやめます。
- 見張りの一覧はセッションごとに保存されるので、セッションを閉じて再開しても続きます。再開したときは 15 秒後に一度見に行きます。セッションが動いていないあいだ（アプリを閉じているあいだ）は見に行きません。

### 既定の後始末

1. `git status` を見て、コミットしていない変更があれば止まって聞く
2. マージ先（ふつうは main）に切り替えて `git pull`
3. マージされたブランチを `git branch -d` で消す（`-D` は使わない。ワークツリーの中では切り替えも削除もしない）
4. `.claude-plugin/plugin.json` の version が上がっていたら、`claude plugin update <name>` を案内する（自分では動かさない）
5. やったことを短くまとめる

## 入れ方

```
/plugin marketplace add holmesfems/merge-watch
/plugin install merge-watch@merge-watch
```

`gh`（GitHub CLI）が入っていて、`gh auth login` 済みであること。

## 使い方

| コマンド | すること |
| --- | --- |
| `/merge-watch` | 見張っている PR の一覧 |
| `/merge-watch <PR の URL>` | その PR を見張りに足す（いくつでも並べられる） |
| `/merge-watch check` | 今すぐ見に行く |
| `/merge-watch stop <URL か番号>` | 見張りをやめる（`stop 73` や `stop #73` でもよい） |

見張っているあいだは、ステータスラインに `merge-watch: #73 を見張り中` と出ます。

## 設定

`/config`（または settings の `pluginConfigs.merge-watch`）で変えられます。

| 項目 | 既定 | 意味 |
| --- | --- | --- |
| `intervalMinutes` | 5 | 見に行く間隔（分）。1〜120 |
| `autoWatch` | true | `gh pr create` で出した PR・bind した PR を自動で見張る |
| `cleanup` | （空） | マージのあとに頼むこと。空なら上の既定の後始末。たとえば「main に切り替えて pull だけして」 |

## 試し方

1. 試しのリポジトリで、このフォルダを読み込んでセッションを始める：
   ```
   claude --plugin-dir <このフォルダ>
   ```
   （入れたあとなら、ふつうに始めるだけでよい）
2. 適当な変更をブランチに積んで、Claude に「PR を出して」と頼む。`gh pr create` が動くと「merge-watch: owner/repo#N のマージを見張ります」と出て、ステータスラインにも出る
3. `/merge-watch` で一覧に入っていることを確かめる
4. GitHub でその PR をマージする
5. `/merge-watch check`（または最大 5 分待つ）で、「マージされました」の知らせのあと、Claude が後始末を始める
6. 閉じるだけの PR でも試すと、知らせが 1 行残って見張りが外れる

自動テスト：

```
claude plugin validate .
claude plugin test .
```

## ファイル

- `hooks/register.ts`：フック（セッションの開始・ツールの呼び出し・`/merge-watch`）と見張りのタイマー
- `hooks/watch.ts`：URL の読み取り・知らせの文面など、`$` を使わない部分
- `tests/merge-watch.test.ts`：テスト

## ライセンス

MIT
