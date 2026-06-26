# 設計: 7/25(花火大会)だけ受付時間を16:00まで延長

作成日: 2026-06-26
対象イベント: 2026-07-25（金沢市花火大会・土曜）

## 目的

2026-07-25のみ、お客様予約の受付時間を通常の14:00最終から **16:00まで延長**し、
30分ごとに予約枠を1組ずつ追加する。7/25以外の挙動は一切変えない。

## 要件

- 7/25に追加する枠: **14:30 / 15:00 / 15:30 / 16:00** の4枠（最終受付16:00）
- 各枠の定員: 1組（既存 `SLOT_CAPACITY = 1` と同じ）
- 開始時刻は変更なし（09:00のまま）。終了側だけ延長＝純粋な追加
- 7/25以外の日は現状と完全に同一の挙動
- 実装方式: **コードに日付を直書き**（単発イベント。DBカラム追加やUI改修はしない）

## 仕組み

「特定日だけの延長枠」を、日付→追加時刻リストの対応として表す。

```
EXTRA_SLOTS_BY_DATE = { '2026-07-25': ['14:30','15:00','15:30','16:00'] }
timesForDate(date)  = ALL_TIMES.concat(EXTRA_SLOTS_BY_DATE[date] || [])
```

各システムで「ALL_TIMES をループ／検証」している箇所を `timesForDate(date)` に差し替える。
7/25以外は `EXTRA_SLOTS_BY_DATE[date]` が undefined → 追加ゼロ → 既存挙動を維持。

`ALL_TIMES` は4箇所に重複定義されている（既存の構造）。今回もその構造に合わせ、
各ファイルに `EXTRA_SLOTS_BY_DATE` と `timesForDate` を局所的に追加する。

## 変更箇所

### 1. supabase/functions/check-slot/index.ts
- `EXTRA_SLOTS_BY_DATE` 定数と `timesForDate(date)` ヘルパーを追加
- スロット計算ループ `for (const t of ALL_TIMES)` → `for (const t of timesForDate(date))`
- 結果: 7/25は15スロット分の空き情報を返す。他日は11スロットのまま

### 2. supabase/functions/save-booking/index.ts
- 同じ `EXTRA_SLOTS_BY_DATE` / `timesForDate` を追加
- 時刻バリデーション `ALL_TIMES.includes(booking.time)` → `timesForDate(booking.date).includes(booking.time)`
- 空き確認(`checkSlotAvailability`)は時刻単位なので変更不要

### 3. reserve.html（お客様フォーム / GitHub Pages配信）
- 時刻 `<select>` に 14:30 / 15:00 / 15:30 / 16:00 の `<option>` を追加。
  ただし延長枠と判別できるよう印を付ける（例: `data-extra-date="2026-07-25"`）
- JS定数 `EXTRA_SLOTS_BY_DATE` を追加
- `updateTimeOptions()` に7/25ガードを追加:
  - 選択日が延長対象でない、または当該時刻がその日の延長リストに無い延長optionは
    `hidden = true; disabled = true` で非表示にする
  - 7/25選択時は通常optionと同じ空き表示ロジックに合流（check-slotがその枠を返すため）
- 翻訳テキストの追加は不要（optionは時刻の数字のみ。3言語共通の同一selectを使用）

### 4. gas-calendar-api.gs（管理画面 / GAS配信）
- `EXTRA_SLOTS_BY_DATE` / `timesForDate` を追加
- `getSlotAvailability(date)` のループ `ALL_TIMES.forEach` → `timesForDate(date).forEach`
  → 管理画面カレンダーで7/25の延長枠の空き・予約が見える
- 管理保存系の時刻検証 `ALL_TIMES.indexOf(booking.time)`（行2133付近）→ `timesForDate(booking.date)` 基準に
- 集計用 `ALL_TIMES.length`（行744/1923付近・「X/11枠」表示）は見た目のみで実害なし。
  今回は触らない（必要なら別途）。kimono-booking.html の手動予約は既存「時間外：直接入力」で対応済み

## 影響範囲・非対象

- 決済(PAY.JP/PayPay)・3DSフロー: 変更なし
- 定員ロジック: SLOT_CAPACITY=1 のまま（「1組」と一致）
- 2026-07-25は土曜。定休日(水曜)・臨時休業設定が無いことを実装時に確認する

## デプロイ手順

1. reserve.html → GitHub Pages（yossi-akari/kimono-calendar）へ反映
2. Supabase Edge Functions: check-slot / save-booking を **`--no-verify-jwt` 付き**で再デプロイ
   - config.toml の `verify_jwt = false` も維持確認（CLAUDE.md記載の事故防止）
3. GAS: `clasp push`
4. デプロイ後、`dailyHealthCheck` を手動実行し全エンドポイント疎通を確認
5. 動作確認: お客様画面で7/25を選び15:00が選択可能・予約完了・管理カレンダーに表示されることを確認。
   7/26など他日で延長枠が出ないことも確認

## イベント後の片付け

`EXTRA_SLOTS_BY_DATE` から `'2026-07-25'` を削除して再デプロイすれば元に戻る（4箇所＋3システム再デプロイ）。
