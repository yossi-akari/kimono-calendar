# CLAUDE.md（プロジェクト固有）

着物レンタル予約システム。お客様向けreserve.htmlとGAS管理画面の組み合わせ。

## プロジェクト基本情報

### 事業背景
- 着物レンタルあかり（金沢市）の自社予約システム
- Activity Japan依存からの脱却が目的（移行完了で月額約¥65,000削減）
- 2026-04-14にSupabase Edge Functionsへ顧客向けAPIを移行

### 対応言語
- 日本語 / 英語 / 中国語の3言語対応
- 翻訳テキストの同期漏れに注意（修正時は3言語セットで更新）

### 決済
- PAY.JP（都度課金・事前決済）
- 現地決済（見積もりモード・成人式系プラン）
  - **海外からの予約は現地決済不可**（2026-10-17〜）。英語/中国語版・ブラウザ言語に日本語なし・自動翻訳中・日本以外の電話番号のいずれかでカード事前決済のみ。reserve.html の `getOnsiteBlockReason()` と save-booking の同名関数（`ONSITE_NOT_ALLOWED`）の2段で判定。判定を変えるときは両方と `tests/onsite-payment-guard.test.js` をセットで更新
  - reserve.html はブラウザの言語設定で初期表示言語を選ぶ（`?lang=ja|en|zh` で指定可、言語ボタンで選んだ言語は localStorage に保存）
- ~~PayPay~~ — 2026-09-22に撤去。決済処理が未実装のまま選択可能で料金未回収になっていたため（下記 失敗ログ 参照）

---

## アーキテクチャ概要

| レイヤー | 担当 | 配信元 |
|---------|------|-------|
| お客様向けフォーム（reserve.html・my-reservation.html） | フロント表示 | **GitHub Pages**（`yossi-akari/kimono-calendar`） |
| お客様向け予約API | check-slot / send-otp / save-booking / config | **Supabase Edge Functions**（4/14移行） |
| 管理画面（kimono-booking / kimono-calendar） | スタッフ専用 | **GAS**（doGet/doPost） |
| 顧客データの保存 | bookingsテーブル | **Supabase**（GAS側からも自動同期） |
| 外部予約（AJ・じゃらん）受信 | スプレッドシート + 同期 | **GAS** → 毎時 Supabase。**AJは掲載終了につき取り込み停止中**（`AJ_IMPORT_ENABLED = false`、2026-10-17〜。再開時は true に戻すだけ） |
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
| `dailyHealthCheck` | 毎日12時 | 2系統を確認。① GAS checkSlot API（管理画面が使う経路）② Supabase `/config` と `/check-slot`（**お客様が実際に通る経路**）。3回連続失敗で初めて ALERT メール。 |
| `weeklyXserverRedirectCheck` | 毎週月曜10時 | Xserver `/reserve/reserve.html` が 301/302 を返すか確認。200 なら ALERT。 |
| `weeklyBookingSummary` | 毎週月曜10時 | WEB予約数の週次/月次サマリーをメール送付（情報のみ・アラートではない）。今後の現地決済予約のうち名前がローマ字・電話番号が海外っぽいものを「確認推奨」欄に一覧表示（該当0件なら欄なし）。 |

**新規セットアップ時:** GASエディタで `setupHealthCheckTriggers()` を1回実行。

**Script Property 必須:** `SUPABASE_ANON_KEY` に **publishable key**（`sb_publishable_` で始まる。値は reserve.html の同名定数と同じ）を設定する。未設定だと「お客様向けAPIが無監視状態」ALERTが毎日飛ぶ。

⚠️ **secret key（`sb_secret_`）・service_role key は入れない。** 特権キーはJWT検証を通過するため、4/18の `verify_jwt` 設定ミスのような障害を監視がすり抜けて見逃す。（このプロジェクトは Supabase の新キー形式を使用。ダッシュボード表記は Publishable key / Secret key）

**誤報対策:** 監視は `fetchForHealthCheck()` 経由で3回（3秒間隔）リトライする。GASの `/exec` は `script.googleusercontent.com` へ302転送される二段構成で、2段目がまれに404を返すため。

**テスト:** `node tests/health-check.test.js` / `node tests/weekly-onsite-review.test.js` / `node tests/aj-import-switch.test.js`（GASのサービスをスタブに差し替えて監視ロジックを検証。`.claspignore` で GAS への push 対象から除外済み）

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

## Ceremony プラン構成（成人式・卒業式系）

2026-04-18追加。`ceremony: true` フラグが付いたプランは「街歩き系オプション全部非表示・専用オプションのみ表示」のexclusiveモードで動く。

### 現在のプラン
- 成人式プラン: 下見・振袖選定の打ち合わせ用（要件すべて任意）
- 成人式前撮りプラン: 撮影本番に向けた打ち合わせ用（振袖選択・撮影内容が必須）
- 卒業式プラン: 下見・袴選定の打ち合わせ用（要件すべて任意）

### 関連フラグ
- プラン側: `ceremony: true`, `consultDateLabel: true` (日時=打ち合わせ日), `requireKimonoChoice: true`, `requireCeremonyPhoto: true`, `isEstimate: true`
- オプション側: `forPlans: ['プラン名',...]`, `kimonoChoice: true` (振袖/袴選択ラジオ), `ceremonyPhotoChoice: true` (撮影内容ラジオ), `estimatePrice: true` (価格不確定。選択時のみ「お見積もり」モード)

### 動的見積もり判定
`isCurrentlyEstimate()` 関数: `plan.isEstimate AND estimatePriceオプション選択中` の時のみ見積もりモード。例:
- 振袖**レンタル**(¥55,000〜・estimatePrice) → 見積もりモード・現地決済固定
- 振袖**持ち込み**(¥15,400・固定) + 撮影 + ヘアメイク → 合計確定・事前決済可能

### 日時表示の強調
ceremonyプラン選択時、日時セクションラベルを「打ち合わせ日時」に変更し、赤枠警告ボックスで「📅 こちらは「打ち合わせ」の日時です ※ ○○式当日の日時ではありません」を表示（成人式/卒業式で文言切替）。

## EMV 3-Dセキュア（カード決済）

PAY.JPの「トークン3Dセキュア」ライブモード**有効化済み**（2026-05-03）。
カード決済は全件、PAY.JPの3DS認証を経由する。

### フロー
1. お客様カード入力 → `payjp.createToken()` 呼び出し
2. トークンの `card.three_d_secure_status` を判定:
   - `verified` / null → 通常進行（OTPモーダル表示）
   - `unverified` → 3DSチャレンジ必要
3. unverifiedの場合:
   - 予約状態を `sessionStorage['reserve_3ds_pending_v1']` に保存（30分TTL）
   - `https://api.pay.jp/v1/tds/{token_id}/start?publishable_key=...` にリダイレクト
   - PAY.JP→カード会社認証ページ（Orico等）でOTP入力
   - 完了後、PAY.JP管理画面で登録済みリダイレクトURL（reserve.html）に戻る
4. `handle3DSReturn()` がページ読込時にクエリパラメータを検出
5. sessionStorageから予約状態を復元、トークンIDを更新
6. OTPメール送信→OTPモーダル表示で通常フローに合流

### PAY.JP管理画面の登録
- リダイレクトURL: `https://yossi-akari.github.io/kimono-calendar/reserve.html`
- 識別子: `reserve-live` (ライブ), `reserve-test` (テスト)
- トークン3Dセキュアモード: **ライブモードのみ**

### 関連commit
`196bdfb` feat: reserve.html に EMV 3-Dセキュア (token-3DS) 対応を追加

### トラブルシューティング
- カード認証が動かない → PAY.JP管理画面で3DSを**「無効」に戻す**だけで即復旧（防御的実装）
- 3DSチャレンジで「OTP届かない」訴えはカード会社側の問題（Orico等）。当方では対応不可

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
  - `deleteSupabaseBooking()` — 削除ボタンのフォールバック
  - `getWebBookingsFromSupabase()` で取得時 `b.time.substring(0,5)` でHH:mmに正規化
  - `getRawBookings()` と `getBookings`ハンドラで reservationId ベースdedup
- **適用範囲**: Supabase化作業時は読み取り(getXxx)だけでなく書き込み(processXxx, deleteXxx, updateXxx)も全部チェック

### [2026-09-22] PayPay「事前決済」が未実装のまま選択可能→料金未回収 ＋ 無料キャンセル返金の停止

- **何が起きたか**: お客様が「PayPay（事前決済）」を選んで予約したが、支払い画面が一切出ず料金が未回収に。PAY.JPにも履歴なし。調査の結果、PayPayは**選択肢のラベルだけが存在し、決済処理が一行も実装されていなかった**。reserve.html はカード（`paymentMethod === 'card'`）のときだけトークンを生成し、save-booking もカードのときだけ課金する。PayPayは `charge_id: null` / `payment_status: 'pending'` で予約だけ成立していた。
- **なぜ長く気付かなかったか**:
  1. 確認メールにも管理者通知メールにも**支払方法が書かれていない** → お客様にも店にも「未払い」のサインが届かない
  2. 管理画面（kimono-calendar）は `payment_status` を読んでいない → 「事前決済（PayPay）」とだけ表示され**支払い済みに見える**
  3. 既存テストが「paypayは課金しない」を*正しい仕様として*PASSさせていた
- **同時に発覚した別バグ**: 4/23のコミット `9d0dbdd`（支払方法を日本語ラベルに統一）で保存値が `'事前決済（クレジットカード）'` になったのに、GAS側の返金判定が `payment === 'card'` のまま取り残された。結果、**4/23以降のWEBカード予約は「無料キャンセル」しても自動返金が一度も実行されていない**（gas-calendar-api.gs の3箇所）。
- **正しい対処**:
  1. reserve.html から PayPay の選択肢を撤去（ラベル・翻訳キー・表示切替すべて）
  2. save-booking に `PAYPAY_DISABLED` ガードを追加。ブラウザキャッシュに残った旧ページからの送信もサーバー側で拒否する
  3. `isCardPayment()` ヘルパーを新設し、日本語ラベルと旧英語コードの両方を判定。返金判定3箇所を差し替え
  4. test-booking-system.sh に再発検知テスト3件を追加
- **適用範囲（教訓）**:
  - **決済手段をUIに出す前に、決済処理が実際にAPIを叩いているかを必ず確認する**。ラベルだけ先に置かない
  - **保存値のフォーマットを変えるときは、その値を `===` で比較している箇所を全部grepする**。表示側だけ直して比較側を忘れると、お金が動かなくなっても画面上は正常に見える
  - 支払方法と入金状況（`payment_status`）は管理画面と通知メールの両方に出す。「予約が取れた」と「お金を受け取った」は別の事実

### [2026-08-06] checkSlot 404 ALERT は誤報。真の問題は「監視がSupabaseを見ていなかった」こと
- **何が起きたか**: 12:37JSTに `dailyHealthCheck` から「checkSlot APIがHTTP 404」ALERTが1通。調査の結果、お客様の予約は一切止まっていなかった
- **404の原因**: GASの `/exec` は `script.googleusercontent.com` のワンタイムURLへ302転送される二段構成で、2段目がまれに404のHTMLエラーページを返す（Google側の瞬断）。デプロイURLは現在も正常（連続10回200）、8/6前後のコミット・デプロイもゼロ
- **見つかった本当の問題**:
  1. 監視にリトライがなく、1回の瞬断で「至急確認してください」級のメールが飛ぶ。お客様側の `apiPost()` は2回リトライするのに監視は0回だった
  2. **監視対象がGASだけだった**。顧客向けは4/14にSupabaseへ移行済みで、reserve.htmlはGASを一切叩かない。つまり4/18のJWT事故クラスの障害が起きても `dailyHealthCheck` は緑のまま黙る状態で、4/5の12日間停止と同じ構図が別の場所に残っていた
- **正しい対処**: `fetchForHealthCheck()` で3回リトライ + `checkSupabaseCustomerApi()` で `/config` と `/check-slot` を publishable key で確認（特権キーだとJWT検証ミスをすり抜ける）。回帰テストは `tests/health-check.test.js`
- **教訓**: 配信経路を移行したら監視対象も移す。監視は「壊れたら困る経路」に張る。監視の誤報は放置すると監視そのものが無意味になる
- **適用範囲**: 監視・アラート全般。今後エンドポイントを移行する際は必ず監視側も追随させる

### [2026-10-12] GASエディタ直接編集とリポジトリの乖離（push で消える寸前）
- **何が起きたか**: PayPay撤去＋返金修正（merge `9a49efc`）を GAS へデプロイしようとしたら、GASエディタに**リポジトリに無いコードが2つ**入っていた。① 上記8/6の監視改修（9/10に作業したが worktree に未コミットのまま、エディタにだけ反映）② `diagnoseAdminSessions()`（セッション切れ調査用の診断関数。エディタに直接貼り付けられ、ローカルのどこにも無かった）。`./deploy.sh` は `clasp push --force` でエディタを丸ごと上書きするため、そのまま実行していたら両方とも黙って消えていた。さらにメインチェックアウトが origin/main より2コミット遅れていたので、そこから実行すると返金修正まで巻き戻るところだった
- **原因**: 「エディタに直接貼る」「worktree で作業してコミットせずに push する」が混在し、**GASの中身＝リポジトリ** という前提が崩れていた。`clasp push --force` は差分を見せずに上書きするので、乖離に気付く機会がない
- **正しい対処**: 一時ディレクトリに `clasp clone <scriptId> <version>` で本番版を取り出し、origin/main と diff。エディタ専用分をリポジトリに取り込んで（PR）、リポジトリ＝本番の状態に戻した
- **教訓（push 前の必須手順）**:
  1. **push する前に、エディタの現在の中身をリポジトリと突き合わせる。** 一時ディレクトリで `clasp clone <scriptId>` → `diff` を取り、リポジトリに無い変更があれば先に取り込む（リポジトリ内で `clasp pull` はしない。作業中のファイルが上書きされる）
  2. **push は最新の main から行う。** メインチェックアウトで実行する前に `git pull` で最新化。worktree から実行する場合も origin/main を取り込み済みか確認
  3. **エディタへの直接貼り付けは避ける。** 診断用など一時的なコードでも、貼ったらその日のうちにリポジトリにコミットするか、使い終わったらエディタから消す
  4. worktree で作業したら、push した時点でコミットまで済ませる。「未コミットのままエディタにだけ反映」が一番見つけにくい
- **適用範囲**: GAS（clasp push / deploy.sh）を使うすべてのデプロイ

### 既知の制約: 管理画面「この予約を編集」ボタンはWEB予約に対して事実上動かない
- **現象**: WEB予約（Supabase only）の編集ボタンを押すと kimono-booking.html に遷移し saveManualToSheet で GAS sheet に新規行が appendRow される。Supabase 側は更新されないため、dedup で Supabase 版が表示され編集反映されないように見える
- **当面の運用回避**: WEB予約の変更は管理画面で編集せず、お客様に my-reservation.html から「変更申請」を出してもらい、管理画面で承認する。Supabase が正しく更新される
- **根本対応**: saveManualToSheet が HP- prefix を検出したら Supabase 側を update するよう改修（未着手）
