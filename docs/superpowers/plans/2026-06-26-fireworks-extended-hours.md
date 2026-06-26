# 7/25花火大会 受付時間延長 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-07-25のみ、お客様予約の受付時間を16:00まで延長し、14:30/15:00/15:30/16:00の4枠（各1組）を追加する。他の日は無変更。

**Architecture:** `ALL_TIMES`（09:00〜14:00）が重複定義されている4箇所それぞれに、日付→延長時刻の対応表 `EXTRA_SLOTS_BY_DATE` とヘルパー `timesForDate(date)` を追加し、枠のループ／時刻バリデーションを `timesForDate(date)` 基準に差し替える。7/25以外は延長ゼロで既存挙動を維持する。

**Tech Stack:** 静的HTML+JS（GitHub Pages）/ Supabase Edge Functions（Deno/TypeScript）/ Google Apps Script。JS単体テストランナーは無いため、検証は (1) 静的grep確認、(2) デプロイ後のlive curl、(3) ブラウザ目視 の3層で行う（既存 `test-booking-system.sh` と同じ思想）。

**延長定義（全箇所で同一にすること）:**
- 日付: `2026-07-25`
- 追加時刻: `14:30`, `15:00`, `15:30`, `16:00`

---

## ファイル構成

| ファイル | 役割 | 変更 |
|---------|------|------|
| `supabase/functions/check-slot/index.ts` | 空き状況API | 定数+ヘルパー追加、枠ループを差し替え |
| `supabase/functions/save-booking/index.ts` | 予約保存・時刻検証 | 定数+ヘルパー追加、検証を差し替え |
| `reserve.html` | お客様フォーム | option追加、JS定数追加、表示ロジックに7/25ガード |
| `gas-calendar-api.gs` | 管理画面カレンダー | 定数+ヘルパー追加、枠ループ・時刻検証を差し替え |
| `test-booking-system.sh` | 検証スクリプト | 時刻whitelist静的チェックの文字列を更新 |

---

## Task 1: check-slot に延長枠を実装

**Files:**
- Modify: `supabase/functions/check-slot/index.ts:9-13`（定数追加）, `:77`（ループ差し替え）

- [ ] **Step 1: ALL_TIMES の直後に延長定義を追加**

`supabase/functions/check-slot/index.ts` の現状（9-13行）:

```ts
const ALL_TIMES = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
  '12:00', '12:30', '13:00', '13:30', '14:00',
];
```

直後に追記する:

```ts
// 特定日だけの延長枠（花火大会など）。7/25のみ16:00まで受付を延長する。
const EXTRA_SLOTS_BY_DATE: Record<string, string[]> = {
  '2026-07-25': ['14:30', '15:00', '15:30', '16:00'],
};
// その日に有効な時刻一覧（通常枠＋その日の延長枠）。延長が無い日はALL_TIMESと同一。
function timesForDate(date: string): string[] {
  return ALL_TIMES.concat(EXTRA_SLOTS_BY_DATE[date] || []);
}
```

- [ ] **Step 2: スロット計算ループを timesForDate に差し替え**

77行目を変更する:

```ts
// 変更前
    for (const t of ALL_TIMES) {
// 変更後
    for (const t of timesForDate(date)) {
```

- [ ] **Step 3: 構文チェック（型・パース）**

Run: `cd supabase/functions/check-slot && deno check index.ts`
Expected: エラー無しで終了（型エラーが出たら修正）。deno未導入なら `npx --yes deno check index.ts`。それも不可ならStep 4のgrepのみで代替。

- [ ] **Step 4: 定義が入ったことを静的確認**

Run: `grep -n "timesForDate(date)" supabase/functions/check-slot/index.ts`
Expected: 関数定義行とループ行（`for (const t of timesForDate(date))`）の2件がヒット

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/check-slot/index.ts
git commit -m "feat(check-slot): 7/25の延長枠(16:00まで)を返すよう対応"
```

---

## Task 2: save-booking に延長枠を許可

**Files:**
- Modify: `supabase/functions/save-booking/index.ts:9-12`（定数追加）, `:442`（検証差し替え）

- [ ] **Step 1: ALL_TIMES の直後に延長定義を追加**

`supabase/functions/save-booking/index.ts` の現状（9-12行）:

```ts
const ALL_TIMES = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
  '12:00', '12:30', '13:00', '13:30', '14:00',
```

ALL_TIMES配列の閉じ括弧の直後に、check-slotと**完全に同一の**定義を追記する:

```ts
// 特定日だけの延長枠（花火大会など）。check-slot と同一に保つこと。
const EXTRA_SLOTS_BY_DATE: Record<string, string[]> = {
  '2026-07-25': ['14:30', '15:00', '15:30', '16:00'],
};
function timesForDate(date: string): string[] {
  return ALL_TIMES.concat(EXTRA_SLOTS_BY_DATE[date] || []);
}
```

- [ ] **Step 2: 時刻バリデーションを差し替え**

442行目を変更する:

```ts
// 変更前
    if (!ALL_TIMES.includes(booking.time)) {
// 変更後
    if (!timesForDate(booking.date).includes(booking.time)) {
```

（`booking.date` はこの行より前の436行で存在チェック済み。未知日付なら timesForDate は ALL_TIMES を返すので従来挙動。空き確認 `checkSlotAvailability` は時刻単位のため変更不要。）

- [ ] **Step 3: 構文チェック**

Run: `cd supabase/functions/save-booking && deno check index.ts`
Expected: エラー無し（不可なら次のgrepで代替）

- [ ] **Step 4: 静的確認**

Run: `grep -n "timesForDate(booking.date).includes" supabase/functions/save-booking/index.ts`
Expected: 1件ヒット（442行付近）

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/save-booking/index.ts
git commit -m "feat(save-booking): 7/25の延長枠の時刻を保存許可"
```

---

## Task 3: reserve.html に延長optionと7/25ガードを実装

**Files:**
- Modify: `reserve.html:424-432`（option追加）, `:718`付近（JS定数追加）, `:1454-1462`（表示ロジック）

- [ ] **Step 1: 時刻selectに延長optionを追加**

`reserve.html` の現状（424-432行）:

```html
          <select id="visitTime">
            <option value="" id="timeSelectOpt">選択してください</option>
            <option>09:00</option><option>09:30</option>
            <option>10:00</option><option>10:30</option>
            <option>11:00</option><option>11:30</option>
            <option>12:00</option><option>12:30</option>
            <option>13:00</option><option>13:30</option>
            <option>14:00</option>
          </select>
```

`<option>14:00</option>` の直後に、延長option（印として `data-extra-date` を付与）を追加する:

```html
            <option>14:00</option>
            <option data-extra-date="2026-07-25">14:30</option>
            <option data-extra-date="2026-07-25">15:00</option>
            <option data-extra-date="2026-07-25">15:30</option>
            <option data-extra-date="2026-07-25">16:00</option>
```

- [ ] **Step 2: JS定数 EXTRA_SLOTS_BY_DATE を追加**

718行目 `let slotAvailability = {};` の直前に追記する:

```javascript
// 特定日だけの延長枠（花火大会など）。サーバ側(check-slot/save-booking/GAS)と同一に保つこと。
const EXTRA_SLOTS_BY_DATE = {
  '2026-07-25': ['14:30', '15:00', '15:30', '16:00']
};
let slotAvailability = {};
```

- [ ] **Step 3: updateTimeOptions に7/25ガードを追加**

現状（1454-1462行）:

```javascript
  [...select.options].forEach(opt => {
    if (!opt.value) return;
    if (sameDayCutoff) {
      opt.disabled = true;
      opt.textContent = `${opt.value}　受付終了`;
      return;
    }
    const slot = slotAvailability[opt.value];
    if (!slot) { opt.disabled = false; opt.textContent = opt.value; return; }
```

`if (!opt.value) return;` の直後に、延長optionの対象日ガードを挿入する:

```javascript
  [...select.options].forEach(opt => {
    if (!opt.value) return;
    // 延長option（data-extra-date付き）は対象日以外では非表示・選択不可にする
    if (opt.dataset.extraDate) {
      const extraTimes = EXTRA_SLOTS_BY_DATE[dateVal] || [];
      if (opt.dataset.extraDate !== dateVal || !extraTimes.includes(opt.value)) {
        opt.hidden = true; opt.disabled = true; return;
      }
      opt.hidden = false; // 対象日では表示し、以降の通常ロジックに合流
    }
    if (sameDayCutoff) {
      opt.disabled = true;
      opt.textContent = `${opt.value}　受付終了`;
      return;
    }
    const slot = slotAvailability[opt.value];
    if (!slot) { opt.disabled = false; opt.textContent = opt.value; return; }
```

（`dateVal` は同関数内の既存変数（1448行 `const dateVal = document.getElementById('visitDate').value;`）を再利用する。7/25選択時はcheck-slotが当該枠を返すので `slotAvailability[opt.value]` が存在し、通常の空き表示（◎空き/予約済等）に合流する。日付変更で延長枠が選択中だった場合は、既存の1480行の「disabled option選択中ならクリア」処理が値をリセットする。）

- [ ] **Step 4: 静的確認**

Run: `grep -n "data-extra-date" reserve.html && grep -n "EXTRA_SLOTS_BY_DATE" reserve.html`
Expected: option 4件 ＋ JS定数1件＋ガード内2件（参照）がヒット

- [ ] **Step 5: ブラウザ目視（ローカル）**

Run: preview_start で `reserve.html` を開く →（プラン選択→日時へ）→ visitDate に `2026-07-25` を入れて visitTime を確認 → 14:30〜16:00 が選べる。次に `2026-07-26` に変えて 14:30〜16:00 が**消える**ことを確認。
Expected: 7/25のみ延長枠表示、他日は非表示。コンソールエラー無し。
（注: ローカルではcheck-slotがCORS/認証で空振りする場合あり。その時 `slotAvailability={}` フォールバックで延長optは「14:30」等が素のまま選択可能になるが、ガード自体（7/25のみ表示）は動く。空き表示の最終確認はTask 6のデプロイ後curl/本番で行う。）

- [ ] **Step 6: Commit**

```bash
git add reserve.html
git commit -m "feat(reserve): 7/25のみ延長枠(14:30-16:00)を選択可能に"
```

---

## Task 4: gas-calendar-api.gs に延長枠を実装

**Files:**
- Modify: `gas-calendar-api.gs:379`（定数追加）, `:3251`（getSlotAvailabilityループ）, `:2133`（時刻検証）

- [ ] **Step 1: ALL_TIMES の直後に延長定義を追加**

現状（378-379行）:

```javascript
const SLOT_CAPACITY = 1;
const ALL_TIMES = ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00'];
```

379行の直後に追記する:

```javascript
// 特定日だけの延長枠（花火大会など）。Supabase側(check-slot/save-booking)・reserve.htmlと同一に保つこと。
const EXTRA_SLOTS_BY_DATE = {
  '2026-07-25': ['14:30','15:00','15:30','16:00']
};
// その日に有効な時刻一覧（通常枠＋延長枠）。延長が無い日はALL_TIMESと同一。
function timesForDate(date) {
  return ALL_TIMES.concat(EXTRA_SLOTS_BY_DATE[date] || []);
}
```

- [ ] **Step 2: getSlotAvailability のループを差し替え**

3251行目を変更する:

```javascript
// 変更前
  ALL_TIMES.forEach(t => {
// 変更後
  timesForDate(date).forEach(t => {
```

- [ ] **Step 3: 管理保存の時刻検証を差し替え**

2133行目を変更する:

```javascript
// 変更前
      if (ALL_TIMES.indexOf(booking.time) === -1) {
// 変更後
      if (timesForDate(booking.date).indexOf(booking.time) === -1) {
```

- [ ] **Step 4: 静的確認**

Run: `grep -n "timesForDate" gas-calendar-api.gs`
Expected: 関数定義1件＋ getSlotAvailability内1件＋ 検証1件 = 3件ヒット

- [ ] **Step 5: Commit**

```bash
git add gas-calendar-api.gs
git commit -m "feat(gas): 管理カレンダーで7/25の延長枠を表示・検証対応"
```

---

## Task 5: test-booking-system.sh の静的チェックを更新

**Files:**
- Modify: `test-booking-system.sh:297`付近（時刻whitelistチェックのgrep文字列）

- [ ] **Step 1: 時刻whitelist静的チェックの文字列を更新**

GAS側の検証が `ALL_TIMES.indexOf(booking.time)` から `timesForDate(booking.date).indexOf(booking.time)` に変わったため、それを検出するgrepへ更新する。現状（297行付近）:

```bash
if grep -q "ALL_TIMES.indexOf(booking.time)" /Users/yossi/my-app/gas-calendar-api.gs; then
```

変更後:

```bash
if grep -q "timesForDate(booking.date).indexOf(booking.time)" /Users/yossi/my-app/gas-calendar-api.gs; then
```

- [ ] **Step 2: 静的確認**

Run: `grep -n "timesForDate(booking.date).indexOf" test-booking-system.sh`
Expected: 1件ヒット

- [ ] **Step 3: Commit**

```bash
git add test-booking-system.sh
git commit -m "test: 時刻whitelistチェックをtimesForDateに追従"
```

---

## Task 6: デプロイと本番検証（人手・CLAUDE.md必須手順）

> このTaskはデプロイ権限が必要。実装エージェントは「準備完了」を報告し、ヒロシが実行する。

**Files:** （コード変更なし。デプロイ操作のみ）

- [ ] **Step 1: GitHub Pages へ reserve.html を反映**

main相当ブランチへマージ後、`yossi-akari/kimono-calendar` の Pages に反映されることを確認（リポジトリの通常デプロイ手順に従う）。

- [ ] **Step 2: Supabase Edge Functions を --no-verify-jwt 付きで再デプロイ**

CLAUDE.md記載の事故防止（JWT検証が有効に戻ると全予約失敗）のため、必ず `--no-verify-jwt` を付ける:

```bash
supabase functions deploy check-slot --no-verify-jwt
supabase functions deploy save-booking --no-verify-jwt
```

`supabase/config.toml` の `[functions.check-slot] verify_jwt = false` / `[functions.save-booking] verify_jwt = false` が維持されていることも確認する。

- [ ] **Step 3: GAS を clasp push**

```bash
./deploy.sh
```

（`clasp push` 実行。デプロイIDが設定済みなら本番デプロイまで自動。未設定ならGASエディタで新バージョンをデプロイ。）

- [ ] **Step 4: check-slot を live curl で検証（7/25は15枠、7/26は11枠）**

anon keyはreserve.html内の公開キー。以下で抽出してcurl:

```bash
ANON=$(grep -oE "SUPABASE_ANON_KEY *= *'[^']+'" reserve.html | sed "s/.*'\\([^']*\\)'.*/\\1/")
BASE=https://ovaauspaumntorumuvrs.supabase.co/functions/v1
echo "--- 2026-07-25 (15枠期待・16:00含む) ---"
curl -s -X POST "$BASE/check-slot" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ANON" -H "apikey: $ANON" \
  -d '{"date":"2026-07-25"}' | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('slots',{}); print('count=',len(s),' has16:00=', '16:00' in s)"
echo "--- 2026-07-26 (11枠期待・16:00無し) ---"
curl -s -X POST "$BASE/check-slot" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ANON" -H "apikey: $ANON" \
  -d '{"date":"2026-07-26"}' | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('slots',{}); print('count=',len(s),' has16:00=', '16:00' in s)"
```

Expected: 7/25 → `count= 15  has16:00= True` ／ 7/26 → `count= 11  has16:00= False`

- [ ] **Step 5: dailyHealthCheck 手動実行＋本番ブラウザ確認**

GASエディタで `dailyHealthCheck` を1回手動実行し、全エンドポイントsuccessを確認（CLAUDE.md手順）。
本番 reserve.html で 2026-07-25 を選び 15:00 が選択でき、テスト予約（または最終段直前まで）で弾かれないこと、管理カレンダーに7/25の延長枠が表示されることを確認。

- [ ] **Step 6: 確認結果を報告**

検証ログ（curl結果・スクショ）を残して完了報告。

---

## イベント後の片付け（参考・本プランの実装対象外）

花火大会終了後、`EXTRA_SLOTS_BY_DATE` から `'2026-07-25'` を削除して4箇所を再デプロイすれば元に戻る。`/schedule` で7/26にリマインドを設定してもよい。

---

## Self-Review

- **Spec coverage:** 設計の4変更箇所 → Task1(check-slot)/Task2(save-booking)/Task3(reserve.html)/Task4(GAS) で網羅。デプロイ手順 → Task6。test-booking-system.shのgrep追従漏れ（spec未記載だが実装上必須）→ Task5で補完。
- **延長定義の一貫性:** 4箇所すべて `'2026-07-25': ['14:30','15:00','15:30','16:00']` で同一。ヘルパー名は全箇所 `timesForDate` で統一。
- **Placeholder scan:** TODO/TBD無し。各コード変更ステップに実コードを記載。
- **既知の注意:** GASの集計用 `ALL_TIMES.length`（744/1923行・「X/11枠」表示）は意図的に変更せず（見た目のみ・実害なし）。kimono-booking.html手動フォームは既存「時間外：直接入力」で対応済みのため変更不要。両者とも設計で非対象と明記済み。
