# CLAUDE.md（プロジェクト固有）

着物レンタル予約システム。お客様向けreserve.htmlとGAS管理画面の組み合わせ。

## アーキテクチャ概要

| レイヤー | 担当 | 配信元 |
|---------|------|-------|
| お客様向けフォーム（reserve.html・my-reservation.html） | フロント表示 | **GitHub Pages**（`yossi-akari/kimono-calendar`） |
| お客様向け予約API | check-slot / send-otp / save-booking / config | **Supabase Edge Functions**（4/14移行） |
| 管理画面（kimono-booking / kimono-calendar） | スタッフ専用 | **GAS**（doGet/doPost） |
| 顧客データの保存 | bookingsテーブル | **Supabase**（GAS側からも自動同期） |
| 外部予約（AJ・じゃらん）受信 | スプレッドシート + 同期 | **GAS** → 毎時 Supabase |
| Xserver `akari-kanazawa.jp/reserve/` | 旧版（廃止予定） | リダイレクト対応中・GAS側でLEGACY_KEYS暫定許可中 |

## セッション起動時の必須チェック

**不具合相談を受けたら、仮説を立てる前に必ず以下を確認すること。**

1. **「いつから症状が出ているか」をユーザーに確認**
   - 直近の大きなコミット（Supabase移行など）に飛びつかない
   - 症状発生時期を確定してから `git log --since="<日付>"` で範囲を絞る
   - 失敗例: 4/17の「予約全部AJ」相談で、最近のSupabase移行（4/14）を犯人と推定したが、実際は4/5のACCESS_KEYローテーションが真因だった（commit `4e56196`）

2. **機密ローテーション履歴を確認**
   - `git log --grep="key\|KEY\|rotation\|ローテーション\|sec:"` で機密変更を洗い出す
   - キー・トークン・シークレットのローテーション後に「外部に置いたコピーが古いまま」になっていないか疑う
   - 特にXserverと GitHub Pages の両方に同じファイルがあるケース（履歴上の遺物含む）

3. **Xserver と GitHub Pages の両方を意識する**
   - reserve.html は両方に存在する可能性がある（廃止後もファイルが残っているケース）
   - akari-kanazawa.jp トップページのリンク先がどちらを指しているか必ず確認
   - お客様の実体験は「akari-kanazawa.jp トップ → /reserve/reserve.html」が主流

4. **ヒロシの「腑に落ちない」は最重要シグナル**
   - 反論せず、仮説を一度ゼロに戻す
   - 「では何が引っかかりますか？」で具体化を促す
   - ヒロシの記憶（「○月○日には動いていた」「△△の前後で変わった」）はバグ調査の一次データとして扱う

## 健全性監視（GAS Time Trigger）

2026-04-17に実装。`gas-calendar-api.gs` 末尾の Health Check セクション。

| 関数 | 実行 | 目的 |
|------|-----|------|
| `dailyHealthCheck` | 毎日12時 | GAS自身の checkSlot API を叩いて success応答を確認。失敗なら ALERT メール。 |
| `weeklyXserverRedirectCheck` | 毎週月曜10時 | Xserver `/reserve/reserve.html` が 301/302 を返すか確認。200 なら ALERT。 |
| `weeklyBookingSummary` | 毎週月曜10時 | WEB予約数の週次/月次サマリーをメール送付（情報のみ・アラートではない）。 |

**新規セットアップ時:** GASエディタで `setupHealthCheckTriggers()` を1回実行。

**ALERT通知先:** `getAdminEmail()`（デフォルト `rentalakari@gmail.com`）

## 機密情報の取り扱い

`ACCESS_KEY` 等の公開APIキーをローテーションする際の**必須手順**:

1. ローテーション前に「キーを埋め込んでいる先」を全部洗い出す
   - GitHub Pages版 reserve.html / my-reservation.html
   - Xserver mirror があれば そこも
   - 他の連携ツール（Make.com, Zapier等）
2. **新キーをすべての配信先に反映してから**、GAS側のScript Propertyを切り替える
3. ローテーション直後に `dailyHealthCheck` を手動実行して全エンドポイントが通ることを確認
4. **コミット例外**: 4/5のローテーション時、Xserver版の更新を忘れて12日間予約が静かに止まった事故あり

## Supabase Edge Functions 作業時の必須チェック

`supabase/functions/` を編集・デプロイする時は以下を毎回確認：

1. **JWT検証フラグ**: 顧客向け関数（reserve.html等から呼ばれる）は `--no-verify-jwt` で デプロイし、`config.toml` の `[functions.<name>] verify_jwt = false` に明記する。再デプロイで飛んで `Invalid JWT` 全失敗になる事故あり（4/18）
2. **日付の曜日計算**: `new Date(dateStr + 'T00:00:00+09:00').getDay()` は **NG**（Deno=UTCで前日が返る）。`getDayOfWeekFromDateStr()` ヘルパー（save-booking/index.ts内に定義）を使う
3. **新規データの読み取り口**: Supabaseに新しく保存するテーブル/カラムは、必ず `getRawBookings()` 等のGAS側読み取り関数からも見えるか確認

## 失敗ログ（このプロジェクト固有）

### [2026-04-17] ACCESS_KEYローテーションでXserver版が予約不能に
- **何が起きたか**: 4/5に `ACCESS_KEY` をpublicリポジトリ対策でローテーションしたが、Xserver上の旧reserve.htmlに埋め込まれた旧キー（`34563456`）の更新を忘れた。結果、akari-kanazawa.jp経由のお客様の予約が4/5〜4/17の12日間すべて Unauthorized で失敗。「予約はAJばかり」という症状で発覚。
- **原因**: ローテーション時に「キーが埋め込まれている全箇所の洗い出し」を行わなかった
- **正しい対処**: 上記「機密情報の取り扱い」手順を必ず踏む。`dailyHealthCheck` で再発検知可能になった
- **適用範囲**: ACCESS_KEY・OTP_SECRET・PAY.JP_SECRET 等あらゆる機密のローテーション時

### [2026-04-18] save-booking 連鎖インシデント（タイムゾーン+JWT+読み取り口）
- **何が起きたか**: 4/30(木)を選んだお客様に「水曜日は定休日」エラー。修正のため再デプロイしたら今度はJWT検証が有効に戻り全予約失敗。さらに修正後、WEB予約は成立するがkimono-calendarに表示されない3段階の連鎖
- **原因**:
  1. `getDay()`がDeno(UTC)で前日を返す（JST midnight=UTC前日15:00）
  2. `--no-verify-jwt` フラグなしの再デプロイでJWT必須に戻った
  3. `getRawBookings()`がGmail/シートからしか読まず、Supabase only保存のWEB予約が見えなかった（4/14のSupabase移行時の潜在ギャップ）
- **正しい対処**: 上記「Supabase Edge Functions 作業時の必須チェック」3点を毎回確認
- **適用範囲**: Supabase Edge Functions の編集・デプロイ全般

### [2026-04-18] my-reservation.html Supabase化と管理画面書き込み系のSupabase対応
- **何をしたか**: my-reservation.htmlからACCESS_KEYを排除するためSupabase Edge Functionsに移行。同時に発見した「管理画面の書き込み系（ステータス更新、申請承認/却下）がGAS sheet前提でWEB予約に対応していない」潜在ギャップも修正
- **追加した関数（GAS）**:
  - `getSupabaseRequestsList()` / `processSupabaseRequest()` — booking_requests連携
  - `processSupabaseBookingStatusUpdate()` — bookings.visit_status更新+PAY.JP返金
- **適用範囲**: Supabase化作業時は読み取り(getXxx)だけでなく書き込み(processXxx, deleteXxx, updateXxx)も全部チェック
