# 期間限定プラン + 撮影プラン不可日 実装計画

## 要件整理

### A. 期間限定プラン
- ベースはベーシックプランと同じ価格（2970円）
- 特典項目を追加（①着物アップグレード ②翌日返却無料）
- プラン名・特典項目・公開期間をGAS側から変更可能にする
- 公開期間外はreserve.htmlのプラン選択に表示しない

### B. 撮影プラン不可日
- kimono-calendarの営業日設定から撮影プラン不可日を設定できる
- ロケ撮影は1日2組が限界
- 9:00-12:00、13:00-14:00でオープン/クローズできる
- 撮影プラン選択時、不可日/不可時間帯には予約できない

### C. reserve.htmlの変更が必要か
- **はい、必要**。理由：
  1. 期間限定プランの特典表示UIが必要
  2. 撮影プラン選択時のスロット制限ロジック追加が必要

---

## 実装計画

### Step 1: GAS — 期間限定プランの動的設定（GASのみ）

**getShopConfig() の期間限定プラン定義を拡張：**

```javascript
// 既存の期間限定プラン定義に追加
{ name: '期間限定', price: 2970, isEstimate: false, badge: 'LIMITED', badgeClass: 'badge-red',
  // 新規フィールド
  basePlan: 'ベーシック',
  benefits: [
    { ja: '着物アップグレード無料', en: 'Free kimono upgrade', zh: '免費升級和服' },
    { ja: '翌日返却無料', en: 'Free next-day return', zh: '免費隔日歸還' }
  ],
  periodStart: '2026-04-01',  // 公開開始日
  periodEnd: '2026-05-31',    // 公開終了日
  ja: { displayName: '春の着物キャンペーン', note: '...' },
  ...
}
```

**getShopConfig() で公開期間フィルタリング：**
- `today` が `periodStart` 〜 `periodEnd` の範囲外ならプラン一覧から除外
- GAS側でフィルタするのでHTML変更不要

### Step 2: GAS — 撮影プラン設定の追加（GASのみ）

**設定シートに撮影プラン列を追加：**
- 既存の設定シート列: `[date, limit, closed, note]`
- 追加列: `photoLimit`（撮影プラン上限、デフォルト2）、`photoBlockedSlots`（ブロック時間帯、カンマ区切り）

**新しいdoPostアクション：**
- `savePhotoSettings` — 日付ごとの撮影プラン設定を保存
- `getPhotoSettings` — 撮影プラン設定を取得

**checkSlot の拡張：**
- レスポンスに `photoRemaining` フィールドを追加
- 撮影プランの予約数をカウントして残り枠を返す

**getSlotAvailability() の拡張：**
- 撮影プラン予約のカウント
- 撮影ブロック時間帯の反映

### Step 3: reserve.html — 期間限定プランの特典表示

**プランカードに特典バッジを表示：**
- `benefits` 配列がある場合、プランカード内に特典リストを表示
- CSS追加：特典バッジのスタイル

**期間限定プランの自動非表示：**
- GAS側で期間外はプランを返さないので、HTML側の変更は最小限
- ただし `benefits` 表示のためのUI追加は必要

### Step 4: reserve.html — 撮影プラン選択時のスロット制限

**撮影プラン選択時：**
- `fetchSlotAvailability()` のレスポンスに `photoRemaining` が含まれる
- 撮影プランが選択されている場合、`photoRemaining === 0` の時間帯を無効化
- 撮影ブロック時間帯も無効化

### Step 5: kimono-calendar.html — 撮影プラン設定UI

**設定モーダルに撮影プラン設定を追加：**
- 「撮影プラン上限（組数）」入力フィールド
- 時間帯ごとの撮影オープン/クローズ切り替え
  - 9:00-12:00 のスロット: 個別にオン/オフ
  - 13:00-14:00 のスロット: 個別にオン/オフ

---

## 変更ファイル一覧

| ファイル | 変更内容 | HTMLの変更？ |
|---------|---------|------------|
| gas-calendar-api.gs | 期間限定プラン拡張、撮影設定API、checkSlot拡張 | — |
| reserve.html | 特典表示UI、撮影スロット制限 | **はい** |
| kimono-calendar.html | 設定モーダルに撮影プラン設定追加 | **はい** |

→ **reserve.html の変更が必要です。畠中さんへの再送付が発生します。**

---

## 実装順序

1. **GAS: 期間限定プラン拡張**（benefits, periodStart/End追加 + フィルタ）
2. **GAS: 撮影プラン設定API**（設定シート拡張 + checkSlot拡張）
3. **reserve.html: 特典表示 + 撮影スロット制限**
4. **kimono-calendar.html: 撮影プラン設定UI**
5. **デプロイ + テスト**
6. **畠中さんへHTML再送付**
