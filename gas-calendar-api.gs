// =============================================================
// Kimono Calendar API — Google Apps Script Web App
// rentalakari@gmail.com アカウントで作成・デプロイしてください
// =============================================================

// =============================================================
// ── アクセスキー（HTMLと同じ値に設定してください） ────────────
// =============================================================
const ACCESS_KEY = 'AkariKimono2026_mK9x';

// =============================================================
// ── メイン: Web App エントリポイント ──────────────────────────
// =============================================================
function doGet(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  // キー認証
  if (!e || e.parameter.key !== ACCESS_KEY) {
    output.setContent(JSON.stringify({ success: false, error: 'Unauthorized' }));
    return output;
  }

  try {
    // 確定予約はキャッシュ利用（重い処理）
    let bookings = getCachedBookings();
    if (!bookings) {
      bookings = getRawBookings();
      setCachedBookings(bookings);
    }
    // キャンセルは毎回リアルタイムで取得・除外（キャッシュなし）
    const cancelledIds = getCancelledIds();
    const filtered = bookings.filter(b => !cancelledIds.has(b.reservationId));
    // 手動予約をスプレッドシートから取得（毎回リアルタイム）
    const manualBookings = getManualSheetBookings();
    const allBookings = [...filtered, ...manualBookings].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.time.localeCompare(b.time);
    });
    output.setContent(JSON.stringify({
      success: true, bookings: allBookings, count: allBookings.length,
      lastUpdated: new Date().toISOString()
    }));
  } catch (err) {
    output.setContent(JSON.stringify({ success: false, error: err.message }));
  }
  return output;
}

// =============================================================
// ── 確定予約を取得（キャンセル除外なし・キャッシュ用） ──────────
// =============================================================
function getRawBookings() {
  const jaran = getJaranBookings();
  const aj    = getActivityJapanBookings();
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  return [...jaran, ...aj]
    .filter(b => b.date >= today)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.time.localeCompare(b.time);
    });
}

// テスト・dailySync用（キャンセル除外済み）
function getAllBookings() {
  const raw = getRawBookings();
  const cancelledIds = getCancelledIds();
  return raw.filter(b => !cancelledIds.has(b.reservationId));
}

// =============================================================
// ── キャンセル済み予約番号を取得 ──────────────────────────────
// じゃらん: reservation_cancel@activityboard.jp
// AJ:       activity-japan@activityjapan.com
// =============================================================
function getCancelledIds() {
  const ids = new Set();

  // じゃらん キャンセルメール
  try {
    const threads = GmailApp.search('from:reservation_cancel@activityboard.jp', 0, 200);
    for (const thread of threads) {
      for (const msg of thread.getMessages()) {
        const m = msg.getPlainBody().match(/予約番号[：:]\s*([A-Za-z0-9]+)/);
        if (m) ids.add(m[1]);
      }
    }
  } catch(e) { Logger.log('じゃらんキャンセルエラー: ' + e.message); }

  // ActivityJapan キャンセルメール
  try {
    const threads = GmailApp.search('from:activity-japan@activityjapan.com', 0, 200);
    for (const thread of threads) {
      for (const msg of thread.getMessages()) {
        const m = msg.getPlainBody().match(/予約番号[：:]\s*(\d+)/);
        if (m) ids.add(m[1]);
      }
    }
  } catch(e) { Logger.log('AJキャンセルエラー: ' + e.message); }

  Logger.log('キャンセル済み件数: ' + ids.size + ' → ' + [...ids].join(', '));
  return ids;
}

// =============================================================
// ── じゃらん（Gmail メール解析） ──────────────────────────────
// 送信元: reservation@activityboard.jp
// 件名:   【予約確定】じゃらんnet 遊び・体験予約_予約確定通知
// =============================================================
function getJaranBookings() {
  try {
    const today    = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    const bookings = [];

    // じゃらんnet予約確定通知メールを検索（直近100件）
    const threads = GmailApp.search(
      'from:reservation@activityboard.jp subject:予約確定', 0, 100
    );

    for (const thread of threads) {
      for (const message of thread.getMessages()) {
        const body    = message.getPlainBody();
        const booking = parseJaranEmail(body);
        if (booking && booking.date >= today) {
          bookings.push(booking);
        }
      }
    }

    Logger.log('じゃらん(Gmail): ' + bookings.length + '件取得');
    return bookings;

  } catch(e) { Logger.log('じゃらんGmailエラー: ' + e.message); return []; }
}

// じゃらん予約確定通知メールをパース
// 例:
//   予約番号：313WKH5GC
//   利用日時：2026/02/23(月) 11:00～12:00
//   プラン名：女性ヘアセット付！着物で散策ベーシックプラン...
//   人数：2名（女性:2名、男性:0名）
//   合計料金(税込)：9,240円
//   体験者氏名：武田　ゆうき(タケダ　ユウキ)様
//   メールアドレス：xxxx@gmail.com
//   電話番号：09056506921
function parseJaranEmail(body) {
  try {
    // ── 予約番号 ──────────────────────────────────────────────
    const idMatch = body.match(/予約番号[：:]\s*([A-Za-z0-9]+)/);
    if (!idMatch) return null;
    const reservationId = idMatch[1].trim();

    // ── 利用日時: "2026/02/23(月) 11:00～12:00" ──────────────
    const dtMatch = body.match(/利用日時[：:]\s*(\d{4})\/(\d{2})\/(\d{2})[^\s]*\s+(\d{2}:\d{2})/);
    if (!dtMatch) return null;
    const date = dtMatch[1] + '-' + dtMatch[2] + '-' + dtMatch[3];
    const time = dtMatch[4];

    // ── プラン名 ──────────────────────────────────────────────
    const planMatch = body.match(/プラン名[：:]\s*([^\n\r]+)/);
    const planRaw = planMatch ? planMatch[1].trim() : '';

    // ── 人数: "2名（女性:1名、男性:1名）" → 女性N名・男性N名 ──
    const peopleFullMatch = body.match(/人数[：:]\s*(\d+)名[^\n\r（(]*[（(]([^)）]+)[)）]/);
    const femaleMatch = peopleFullMatch ? peopleFullMatch[2].match(/女性[：:]\s*(\d+)/) : null;
    const maleMatch   = peopleFullMatch ? peopleFullMatch[2].match(/男性[：:]\s*(\d+)/) : null;
    const femaleCount = femaleMatch ? parseInt(femaleMatch[1]) : 0;
    const maleCount   = maleMatch   ? parseInt(maleMatch[1])   : 0;
    const peopleBreakdown = [];
    if (femaleCount > 0) peopleBreakdown.push('女性' + femaleCount + '名');
    if (maleCount   > 0) peopleBreakdown.push('男性' + maleCount   + '名');
    const totalPeople = peopleFullMatch ? peopleFullMatch[1] : '1';
    const peopleStr = peopleBreakdown.length > 0 ? peopleBreakdown.join('・') : totalPeople + '名';

    // ── オプション: ヘアセット付きプランなら女性人数分を自動生成 ──
    const options = [];
    if (planRaw.includes('ヘアセット') && femaleCount > 0) {
      options.push({ name: '女性ヘアセット×' + femaleCount, price: 0 });
    }

    // ── 支払方法 ──────────────────────────────────────────────
    const paymentMatch = body.match(/支払方法[：:]\s*([^\n\r]+)/);
    const payment = paymentMatch ? paymentMatch[1].trim() : '';

    // ── 合計料金(税込) ────────────────────────────────────────
    const amtMatch = body.match(/合計料金[^：:]*[：:]\s*([\d,]+)円/);
    const total = amtMatch ? parseInt(amtMatch[1].replace(/,/g, '')) : 0;

    // ── ポイント利用 ──────────────────────────────────────────
    const pointMatch = body.match(/ポイント利用額[：:]\s*([\d,]+)/);
    const pointUsed = pointMatch ? parseInt(pointMatch[1].replace(/,/g, '')) : 0;

    // ── クーポン利用 ──────────────────────────────────────────
    const couponMatch = body.match(/クーポン利用額[：:]\s*([\d,]+)/);
    const couponUsed = couponMatch ? parseInt(couponMatch[1].replace(/,/g, '')) : 0;

    // ── 体験者氏名 ────────────────────────────────────────────
    const nameMatch = body.match(/体験者氏名[：:]\s*([^(\n\r]+)/);
    const name = nameMatch
      ? nameMatch[1].replace(/\s*様$/, '').trim().replace(/[\u3000\s]+/g, ' ')
      : '(名前不明)';

    // ── メールアドレス ────────────────────────────────────────
    const emailMatch = body.match(/メールアドレス[：:\s]+([^\s\n\r]+)/);
    const email = emailMatch ? emailMatch[1].trim() : '';

    // ── 電話番号 ──────────────────────────────────────────────
    const telMatch = body.match(/電話番号[：:]\s*([0-9\-]+)/);
    const tel = telMatch ? telMatch[1].trim() : '';

    // ── 備考: 「予約者からの回答：」の次の行 ─────────────────
    const remarksMatch = body.match(/予約者からの回答[：:]\s*[\r\n]+\s*([^\r\n━─\-]+)/);
    const remarks = remarksMatch ? remarksMatch[1].trim() : '';

    return {
      id: 'jaran_' + reservationId,
      source: 'じゃらん',
      date, time, name,
      plan: parsePlanType(planRaw),
      people: peopleStr,
      options, total, payment, pointUsed, couponUsed,
      email, tel, remarks,
      createdAt: new Date().toISOString(),
      reservationId,
      bookingStatus: '確定予約'
    };
  } catch(e) { return null; }
}

function parsePlanType(planStr) {
  if (planStr.includes('プレミアム'))  return 'プレミアム';
  if (planStr.includes('スタンダード')) return 'スタンダード';
  if (planStr.includes('ベーシック'))  return 'ベーシック';
  if (planStr.includes('撮影'))        return '撮影付き';
  if (planStr.includes('加賀友禅'))    return '加賀友禅';
  if (planStr.includes('成人式'))      return '成人式下見';
  if (planStr.includes('卒業式'))      return '卒業式下見';
  if (planStr.includes('期間限定'))    return '期間限定';
  return 'ベーシック';
}

// =============================================================
// ── ActivityJapan（Gmail メール解析） ────────────────────────
// =============================================================
function getActivityJapanBookings() {
  try {
    const today    = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    const bookings = [];

    const threads = GmailApp.search(
      'from:reserve-system@activityjapan.com subject:確定予約通知', 0, 100
    );

    for (const thread of threads) {
      for (const message of thread.getMessages()) {
        const body    = message.getPlainBody();
        const booking = parseAJEmail(body);
        if (booking && booking.date >= today) {
          bookings.push(booking);
        }
      }
    }

    Logger.log('ActivityJapan(Gmail): ' + bookings.length + '件取得');
    return bookings;

  } catch(e) { Logger.log('AJ Gmailエラー: ' + e.message); return []; }
}

// ActivityJapan確定予約メールをパース
function parseAJEmail(body) {
  try {
    const idMatch = body.match(/予約番号[：:]\s*(\d+)/);
    if (!idMatch) return null;
    const reservationId = idMatch[1];

    const dateMatch = body.match(/日時[：:]\s*(\d{4})年(\d{2})月(\d{2})日/);
    if (!dateMatch) return null;
    const date = dateMatch[1] + '-' + dateMatch[2] + '-' + dateMatch[3];

    // 時刻: 「（09:00 ）」のように閉じ括弧前にスペースがある場合も対応
    const timeMatch = body.match(/[（(](\d{2}:\d{2})\s*[）)]/);
    const time = timeMatch ? timeMatch[1] : '00:00';

    const nameMatch = body.match(/氏名[：:]\s*([^\n（(]+)/);
    const name = nameMatch ? nameMatch[1].trim() : '(名前不明)';

    const planMatch = body.match(/プラン名[（(][^)）]*[)）][：:]\s*([^\n]+)/);
    const planRaw = planMatch ? planMatch[1].trim() : '';

    // ── 予約人数セクション（予約人数: ～ 合計料金 の間）を解析 ──
    // 人数カテゴリ: 大人・女性・男性・カップル・小人
    // それ以外の「名称×N単位」パターンはオプション
    const PEOPLE_KW = ['大人', '女性', '男性', 'カップル', '小人'];
    const peopleItems = [];
    const optionsList = [];

    const secStart = body.indexOf('予約人数');
    const secEnd   = body.indexOf('合計料金');
    if (secStart >= 0 && secEnd > secStart) {
      let section = body.substring(secStart, secEnd);
      // 「予約人数：」ヘッダー部分を除去（同行にアイテムが続く場合も対応）
      section = section.replace(/^予約人数[^\r\n：:]*[：:]/, '');

      // 「商品名×N (人|組|台|名)」パターンをグローバル検索
      // 行末に ¥X,XXX / X,XXX円 の単価があれば同時に取得
      const itemRegex = /([^\s\u3000\n\r][^×\n\r]*?)×(\d+)\s*(人|組|台|名)[^\S\n\r]*(?:[¥￥]([\d,]+)|([\d,]+)円)?/g;
      let m;
      while ((m = itemRegex.exec(section)) !== null) {
        const rawName  = m[1].replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');
        const count    = m[2];
        const priceNum = m[4] ? parseInt(m[4].replace(/,/g,''))
                       : m[5] ? parseInt(m[5].replace(/,/g,'')) : 0;
        if (!rawName) continue;

        // 人数キーワード判定:
        // 「カップル×1組」→ 人数 / 「女性ヘアセット×1人」→ オプション
        const kw = PEOPLE_KW.find(k => {
          if (!rawName.startsWith(k)) return false;
          const next = rawName.slice(k.length);
          return !next || !/^[ぁ-んァ-ヶー一-龯々]/.test(next);
        });

        if (kw) {
          const priceStr = priceNum > 0 ? `（¥${priceNum.toLocaleString()}）` : '';
          peopleItems.push(`${kw}${count}名${priceStr}`);
        } else {
          optionsList.push({ name: rawName + '×' + count, price: priceNum });
        }
      }
    }

    const peopleStr = peopleItems.length > 0 ? peopleItems.join('・') : '1名';

    // 合計料金: 「合計料金　　：7,370円」コロン前の任意の文字に対応
    const amtMatch = body.match(/合計料金[^：:0-9]*[：:]\s*([\d,]+)/);
    const total = amtMatch ? parseInt(amtMatch[1].replace(/,/g, '')) : 0;

    // 備考（AJ定型文は除外）
    // パターン1: 「備考：テキスト」が同一行にある場合
    // パターン2: 「備考：（空行）テキスト」で次の行に定型文が来る場合
    const remarksMatch = body.match(/備考[：:]\s*([^\n\r]*(?:\n\r?|\r\n?)([^\n\r]+))?/);
    let remarksRaw = '';
    if (remarksMatch) {
      // 同行にテキストがあればそれを使用、なければ次の行を使用
      remarksRaw = (remarksMatch[1] || '').trim();
      if (!remarksRaw && remarksMatch[2]) remarksRaw = remarksMatch[2].trim();
    }
    const AJ_SYSTEM_MSG = 'アクティビティジャパン予約管理システムをご利用ください';
    const remarks = remarksRaw.includes(AJ_SYSTEM_MSG) ? '' : remarksRaw;

    return {
      id: 'aj_' + reservationId, source: 'AJ',
      date, time, name,
      plan: parsePlanType(planRaw),
      people: peopleStr,
      options: optionsList, total, email: '', tel: '', remarks,
      createdAt: new Date().toISOString(),
      reservationId, bookingStatus: '確定予約'
    };
  } catch(e) { return null; }
}

// =============================================================
// ── 手動予約（スプレッドシート保存） ──────────────────────────────
// =============================================================
function getManualSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('手動予約');
  if (!sheet) {
    sheet = ss.insertSheet('手動予約');
    sheet.appendRow(['id','date','time','name','plan','channel','people','options','total','payment','tel','email','remarks','createdAt']);
  }
  return sheet;
}

function getManualSheetBookings() {
  try {
    const sheet = getManualSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];
    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    return data.slice(1)
      .filter(row => row[0] && String(row[1]) >= today)
      .map(row => ({
        id: String(row[0]), source: 'MANUAL',
        date: String(row[1]), time: String(row[2]), name: String(row[3]), plan: String(row[4]),
        channel: String(row[5]), people: String(row[6]),
        options: JSON.parse(row[7] || '[]'),
        total: parseInt(row[8]) || 0,
        payment: String(row[9]), tel: String(row[10]), email: String(row[11]),
        remarks: String(row[12]), createdAt: String(row[13]),
        reservationId: String(row[0]), bookingStatus: '手動入力'
      }));
  } catch(e) { Logger.log('手動予約取得エラー: ' + e.message); return []; }
}

function saveManualToSheet(booking) {
  const sheet = getManualSheet();
  sheet.appendRow([
    booking.id, booking.date, booking.time, booking.name, booking.plan,
    booking.channel || '', booking.people,
    JSON.stringify(booking.options || []),
    booking.total || 0, booking.payment || '',
    booking.tel || '', booking.email || '',
    booking.remarks || '', booking.createdAt
  ]);
}

function deleteManualFromSheet(id) {
  const sheet = getManualSheet();
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

// =============================================================
// ── Web App POST エントリポイント ─────────────────────────────
// =============================================================
function doPost(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.key !== ACCESS_KEY) {
      output.setContent(JSON.stringify({ success: false, error: 'Unauthorized' }));
      return output;
    }
    if (data.action === 'save') {
      saveManualToSheet(data.booking);
      output.setContent(JSON.stringify({ success: true }));
    } else if (data.action === 'delete') {
      deleteManualFromSheet(data.id);
      output.setContent(JSON.stringify({ success: true }));
    } else {
      output.setContent(JSON.stringify({ success: false, error: 'Unknown action' }));
    }
  } catch(err) {
    output.setContent(JSON.stringify({ success: false, error: err.message }));
  }
  return output;
}

// =============================================================
// ── キャッシュ管理 ─────────────────────────────────────────────
// =============================================================
function getCachedBookings() {
  try { const c = CacheService.getScriptCache().get('bookings_v1'); return c ? JSON.parse(c) : null; }
  catch(e) { return null; }
}
function setCachedBookings(b) {
  try { const s = JSON.stringify(b); if (s.length < 90000) CacheService.getScriptCache().put('bookings_v1', s, 3600); }
  catch(e) {}
}
function clearCache() { CacheService.getScriptCache().remove('bookings_v1'); Logger.log('キャッシュクリア'); }

// =============================================================
// ── 毎朝8時 自動同期トリガー ──────────────────────────────────
// =============================================================
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'dailySync') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailySync').timeBased().everyDays(1).atHour(8).inTimezone('Asia/Tokyo').create();
  Logger.log('毎朝8時（JST）のトリガーを設定しました');
}
function dailySync() {
  try { clearCache(); const b = getAllBookings(); setCachedBookings(b); Logger.log('同期完了: ' + b.length + '件'); }
  catch(e) { Logger.log('同期エラー: ' + e.message); }
}

// =============================================================
// ── テスト・デバッグ関数 ───────────────────────────────────────
// =============================================================
function testJaran() {
  const b = getJaranBookings();
  Logger.log('じゃらん(Gmail): ' + b.length + '件');
  if (b[0]) Logger.log(JSON.stringify(b[0], null, 2));
}

function testActivityJapan() {
  const b = getActivityJapanBookings();
  Logger.log('AJ: ' + b.length + '件');
  if (b[0]) Logger.log(JSON.stringify(b[0], null, 2));
}

function testAll() {
  Logger.log('合計: ' + getAllBookings().length + '件');
}

function testCancelledIds() {
  const ids = getCancelledIds();
  Logger.log('キャンセル済み予約番号 (' + ids.size + '件): ' + [...ids].join(', '));
  const all_before = [...getJaranBookings(), ...getActivityJapanBookings()];
  Logger.log('キャンセル除外前: ' + all_before.length + '件');
  Logger.log('キャンセル除外後: ' + getAllBookings().length + '件');
}

// ActivityJapanメールの生テキストと indexOf 結果を確認するデバッグ関数
function debugAJ() {
  const threads = GmailApp.search(
    'from:reserve-system@activityjapan.com subject:確定予約通知', 0, 5
  );
  Logger.log('スレッド数: ' + threads.length);
  if (threads.length === 0) return;

  // 最新メール（threads[0]）を確認
  const msg = threads[0].getMessages()[0];
  const body = msg.getPlainBody();
  Logger.log('件名: ' + msg.getSubject());
  Logger.log('予約人数 の位置: ' + body.indexOf('予約人数'));
  Logger.log('合計料金 の位置: ' + body.indexOf('合計料金'));
  Logger.log('--- 本文（先頭2000文字）---\n' + body.substring(0, 2000));
}

// 予約人数セクションの解析状態を詳しく確認するデバッグ関数
function debugPeopleSection() {
  const threads = GmailApp.search(
    'from:reserve-system@activityjapan.com subject:確定予約通知', 0, 5
  );
  if (threads.length === 0) { Logger.log('メールなし'); return; }
  const body = threads[0].getMessages()[0].getPlainBody();

  const secStart = body.indexOf('予約人数');
  const secEnd   = body.indexOf('合計料金');
  Logger.log('secStart=' + secStart + '  secEnd=' + secEnd);

  if (secStart < 0 || secEnd <= secStart) {
    Logger.log('セクションが見つかりません');
    return;
  }

  let section = body.substring(secStart, secEnd);
  Logger.log('--- セクション生テキスト(JSON) ---\n' + JSON.stringify(section));

  section = section.replace(/^予約人数[^\r\n：:]*[：:]/, '');
  Logger.log('--- ヘッダー除去後(JSON) ---\n' + JSON.stringify(section));

  // 正規表現マッチを列挙
  const itemRegex = /([^\s\u3000\n\r][^×\n\r]*?)×(\d+)\s*(人|組|台|名)[^\S\n\r]*(?:[¥￥]([\d,]+)|([\d,]+)円)?/g;
  let m; let count = 0;
  while ((m = itemRegex.exec(section)) !== null) {
    count++;
    Logger.log('マッチ' + count + ': name=[' + m[1] + '] count=' + m[2] + ' unit=' + m[3] + ' price=' + (m[4]||m[5]||'なし'));
  }
  if (count === 0) Logger.log('★ マッチなし — 正規表現がセクションにヒットしていません');
}

// じゃらんメールの生テキストを確認するデバッグ関数
function debugJaran() {
  const threads = GmailApp.search('from:reservation@activityboard.jp subject:予約確定', 0, 5);
  if (threads.length === 0) {
    Logger.log('じゃらんからのメールが見つかりません');
    Logger.log('検索条件: from:reservation@activityboard.jp subject:予約確定');
    return;
  }
  Logger.log('スレッド数: ' + threads.length);
  const msg = threads[0].getMessages()[0];
  Logger.log('件名: ' + msg.getSubject());
  Logger.log('送信元: ' + msg.getFrom());
  Logger.log('本文（先頭1500文字）:\n' + msg.getPlainBody().substring(0, 1500));
}
