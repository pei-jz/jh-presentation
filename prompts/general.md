---
title: プレゼンを作る (汎用)
description: テーマ・持ち時間・聞き手を指定して発表用デッキを作る
args:
  topic: 発表のテーマ・内容
  minutes: 持ち時間 (分) (任意)
  audience: 聞き手 (例: エンジニア) (任意)
  theme: テーマ名 (任意。未指定なら内容に合わせて選ぶ)
  motion: 演出レベル (控えめ / 標準 / 多め) (任意)
  brand: 名前・ロゴの帯 (なし / 上 / 下 / 上下) (任意)
---
次の内容で発表用のデッキを作ってください。

- テーマ: {{topic}}
- 持ち時間: {{minutes|15}} 分
- 聞き手: {{audience|一般の聞き手}}
- デザインテーマ: {{theme|内容と聞き手に合うものを list_themes から選ぶ}}

進め方:
1. get_guide を読む。
2. 構成案 (各スライドのタイトルと要点) を作り、私に確認する。
3. 承認後に作成し、audit_deck と screenshot_deck で確認・修正する。
4. 完成したら open_deck で開き、使ったテーマと構成の要点を報告する。

## 演出・ブランド
- 演出レベル: {{motion|標準}} (get_guide の「演出レベル」に従う)
- ブランド枠 (名前・ロゴ): {{brand|brand.json の既定}} (なし=none / 上=header / 下=footer / 上下=both)
