// =============================================================
// Kimono Calendar API — Google Apps Script Web App
// rentalakari@gmail.com アカウントで作成・デプロイしてください
// =============================================================

// =============================================================
// ── アクセスキー（HTMLと同じ値に設定してください） ────────────
// =============================================================
const ACCESS_KEY = 'AkariKimono2026_mK9x';

// =============================================================
// ── 定員設定 ─────────────────────────────────────────────────
// 1スロット（30分）あたりの最大受入人数
// =============================================================
const SLOT_CAPACITY = 2;
const ALL_TIMES = ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00'];

// サイトのベースURL（予約確認メールのリンクに使用）
// 例: 'https://akari-kanazawa.jp' → Script Properties の SITE_BASE_URL で設定
function getSiteBaseUrl() {
  return PropertiesService.getScriptProperties().getProperty('SITE_BASE_URL') || '';
}

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

  // 手動予約の保存・削除・各種アクション
  const action = e.parameter.action;
  if (action === 'save') {
    try {
      const booking = JSON.parse(e.parameter.booking);
      // WEB予約のみ定員チェック（管理者手動入力はスキップ）
      if (booking.source === 'WEB') {
        const peopleCount = parsePeopleCount(booking.people);
        const slots = getSlotAvailability(booking.date);
        const slot = slots[booking.time];
        if (slot && slot.remaining < peopleCount) {
          output.setContent(JSON.stringify({ success: false, error: 'SLOT_FULL', remaining: slot.remaining }));
          return output;
        }
      }
      saveManualToSheet(booking);
      if (booking.source === 'WEB') {
        sendConfirmationEmail(booking);
        sendAdminNotification(booking);
      }
      output.setContent(JSON.stringify({ success: true }));
    } catch(err) {
      output.setContent(JSON.stringify({ success: false, error: err.message }));
    }
    return output;
  }
  if (action === 'delete') {
    try {
      deleteManualFromSheet(e.parameter.id);
      output.setContent(JSON.stringify({ success: true }));
    } catch(err) {
      output.setContent(JSON.stringify({ success: false, error: err.message }));
    }
    return output;
  }
  // 時間帯の空き状況を返す（reserve.html での事前チェック用）
  if (action === 'checkSlot') {
    try {
      const date = e.parameter.date;
      if (!date) throw new Error('date required');
      output.setContent(JSON.stringify({ success: true, slots: getSlotAvailability(date), capacity: SLOT_CAPACITY }));
    } catch(err) {
      output.setContent(JSON.stringify({ success: false, error: err.message }));
    }
    return output;
  }
  // 顧客による予約照会（予約番号 + メールアドレスで認証）
  if (action === 'getBookingForCustomer') {
    try {
      const id    = e.parameter.id;
      const email = (e.parameter.email || '').toLowerCase().trim();
      if (!id || !email) throw new Error('予約番号とメールアドレスを入力してください');
      if (!id.startsWith('HP-')) throw new Error('このページではウェブ予約（HP-から始まる予約番号）のみ確認できます');
      const booking = findCustomerBooking(id, email);
      if (!booking) throw new Error('予約が見つかりません。予約番号またはメールアドレスをご確認ください。');
      const pending = getPendingRequestForBooking(id);
      output.setContent(JSON.stringify({ success: true, booking, pendingRequest: pending }));
    } catch(err) {
      output.setContent(JSON.stringify({ success: false, error: err.message }));
    }
    return output;
  }
  // 変更・キャンセル申請の送信
  if (action === 'submitRequest') {
    try {
      const id      = e.parameter.id;
      const email   = (e.parameter.email || '').toLowerCase().trim();
      const type    = e.parameter.type; // 'change' | 'cancel'
      const newDate = e.parameter.newDate || '';
      const newTime = e.parameter.newTime || '';
      const message = e.parameter.message || '';
      if (!id || !email || !type) throw new Error('パラメータが不足しています');
      const booking = findCustomerBooking(id, email);
      if (!booking) throw new Error('予約が見つかりません');
      if (getPendingRequestForBooking(id)) throw new Error('この予約にはすでに申請中のリクエストがあります');
      const requestId = 'REQ-' + new Date().getTime();
      saveRequest({ requestId, bookingId: id, bookingName: booking.name, type, status: 'pending', newDate, newTime, message, submittedAt: new Date().toISOString() });
      sendRequestNotification(booking, type, newDate, newTime, message, requestId);
      output.setContent(JSON.stringify({ success: true, requestId }));
    } catch(err) {
      output.setContent(JSON.stringify({ success: false, error: err.message }));
    }
    return output;
  }
  // 管理者用：申請一覧取得
  if (action === 'getRequests') {
    try {
      const statusFilter = e.parameter.status || 'pending';
      output.setContent(JSON.stringify({ success: true, requests: getRequestsList(statusFilter) }));
    } catch(err) {
      output.setContent(JSON.stringify({ success: false, error: err.message }));
    }
    return output;
  }
  // 管理者用：申請を承認・却下
  if (action === 'processRequest') {
    try {
      const requestId = e.parameter.requestId;
      const decision  = e.parameter.decision; // 'approve' | 'reject'
      const adminNote = e.parameter.adminNote || '';
      if (!requestId || !decision) throw new Error('パラメータが不足しています');
      processRequestById(requestId, decision, adminNote);
      output.setContent(JSON.stringify({ success: true }));
    } catch(err) {
      output.setContent(JSON.stringify({ success: false, error: err.message }));
    }
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
    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

    // reservationId → { booking, receivedAt }
    const originalMap = {};
    const changeMap   = {};

    // ① 確定予約通知メール
    const newThreads = GmailApp.search(
      'from:reserve-system@activityjapan.com subject:確定予約通知', 0, 100
    );
    for (const thread of newThreads) {
      for (const message of thread.getMessages()) {
        const booking = parseAJEmail(message.getPlainBody());
        if (!booking) continue;
        const prev = originalMap[booking.reservationId];
        if (!prev || message.getDate() > prev.receivedAt) {
          originalMap[booking.reservationId] = { booking, receivedAt: message.getDate() };
        }
      }
    }

    // ② 予約内容変更通知メール
    const changeThreads = GmailApp.search(
      'subject:予約内容変更のお知らせ', 0, 100
    );
    for (const thread of changeThreads) {
      for (const message of thread.getMessages()) {
        const booking = parseAJChangeEmail(message.getPlainBody());
        if (!booking) continue;
        const prev = changeMap[booking.reservationId];
        if (!prev || message.getDate() > prev.receivedAt) {
          changeMap[booking.reservationId] = { booking, receivedAt: message.getDate() };
        }
      }
    }

    // マージ：変更メールがある場合は日時・内容を更新し、氏名等は元予約から引き継ぐ
    const merged = {};
    for (const [id, orig] of Object.entries(originalMap)) {
      if (changeMap[id]) {
        const changed = changeMap[id].booking;
        merged[id] = {
          ...changed,
          name:      orig.booking.name,
          email:     orig.booking.email,
          tel:       orig.booking.tel,
          createdAt: orig.booking.createdAt,
          remarks:   changed.remarks || orig.booking.remarks,
          bookingStatus: '変更済'
        };
      } else {
        merged[id] = orig.booking;
      }
    }
    // 確定メールが取得範囲外でも変更メールだけある場合
    for (const [id, ch] of Object.entries(changeMap)) {
      if (!merged[id]) merged[id] = ch.booking;
    }

    const bookings = Object.values(merged).filter(b => b.date >= today);
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

// ActivityJapan 予約内容変更メールをパース
// 件名：【アクティビティジャパン】予約内容変更のお知らせ
function parseAJChangeEmail(body) {
  try {
    // 予約番号: 【予約番号】：2602281866326
    const idMatch = body.match(/(?:【予約番号】|予約番号)[：:]\s*(\d+)/);
    if (!idMatch) return null;
    const reservationId = idMatch[1];

    // 実施日: アクティビティ実施日：2026年04月04日
    const dateMatch = body.match(/アクティビティ実施日[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!dateMatch) return null;
    const date = dateMatch[1] + '-'
      + String(dateMatch[2]).padStart(2, '0') + '-'
      + String(dateMatch[3]).padStart(2, '0');

    // 時刻: コース名：11:30コース
    const timeMatch = body.match(/コース名[：:]\s*(\d{2}:\d{2})/);
    const time = timeMatch ? timeMatch[1] : '00:00';

    // プラン名
    const planMatch = body.match(/プラン名[：:]\s*([^\n]+)/);
    const planRaw = planMatch ? planMatch[1].trim() : '';

    // 申込数セクション解析（申込数 ～ 合計料金 の間）
    const PEOPLE_KW = ['大人', '女性', '男性', 'カップル', '小人'];
    const peopleItems = [];
    const optionsList = [];

    const secStart = body.indexOf('申込数');
    const secEnd   = body.indexOf('合計料金');
    if (secStart >= 0 && secEnd > secStart) {
      const section = body.substring(secStart, secEnd);
      // 「カップル1組」「男性ヘアセット1人」のような形式をマッチ
      const lineRegex = /([^\s\u3000\n\r][^\n\r]*?)(\d+)(人|名|組)/g;
      let m;
      while ((m = lineRegex.exec(section)) !== null) {
        const rawName = m[1].replace(/[\s\u3000　]+/g, '').replace(/申込数[：:]?/, '').trim();
        const count   = m[2];
        if (!rawName) continue;
        const kw = PEOPLE_KW.find(k => {
          if (!rawName.startsWith(k)) return false;
          const next = rawName.slice(k.length);
          return !next || !/^[ぁ-んァ-ヶー一-龯々]/.test(next);
        });
        if (kw) {
          peopleItems.push(`${kw}${count}名`);
        } else {
          optionsList.push({ name: rawName + '×' + count, price: 0 });
        }
      }
    }

    const peopleStr = peopleItems.length > 0 ? peopleItems.join('・') : '1名';

    // 合計料金
    const amtMatch = body.match(/合計料金[^：:0-9]*[：:]\s*([\d,]+)/);
    const total = amtMatch ? parseInt(amtMatch[1].replace(/,/g, '')) : 0;

    return {
      id: 'aj_' + reservationId, source: 'AJ',
      date, time, name: '',   // 氏名は確定予約メールから引き継ぐ
      plan: parsePlanType(planRaw),
      people: peopleStr,
      options: optionsList, total, email: '', tel: '', remarks: '',
      createdAt: new Date().toISOString(),
      reservationId, bookingStatus: '変更済'
    };
  } catch(e) { return null; }
}

// =============================================================
// ── 手動予約（スプレッドシート保存） ──────────────────────────────
// =============================================================
function getManualSheet() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  const ssId = props.getProperty('manual_ss_id');
  if (ssId) {
    try { ss = SpreadsheetApp.openById(ssId); } catch(e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }
  if (!ss) {
    ss = SpreadsheetApp.create('着物カレンダー_手動予約');
    props.setProperty('manual_ss_id', ss.getId());
    Logger.log('スプレッドシート作成: ' + ss.getUrl());
  }
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
      .filter(row => {
        if (!row[0]) return false;
        const d = row[1] instanceof Date
          ? Utilities.formatDate(row[1], 'Asia/Tokyo', 'yyyy-MM-dd')
          : String(row[1]);
        return d >= today;
      })
      .map(row => {
        const src = String(row[5]) === 'ウェブサイト' && String(row[0]).startsWith('HP-') ? 'WEB' : 'MANUAL';
        return {
          id: String(row[0]), source: src,
          date: row[1] instanceof Date ? Utilities.formatDate(row[1], 'Asia/Tokyo', 'yyyy-MM-dd') : String(row[1]),
          time: row[2] instanceof Date ? Utilities.formatDate(row[2], 'Asia/Tokyo', 'HH:mm') : String(row[2]),
          name: String(row[3]), plan: String(row[4]),
          channel: String(row[5]), people: String(row[6]),
          options: JSON.parse(row[7] || '[]'),
          total: parseInt(row[8]) || 0,
          payment: String(row[9]), tel: String(row[10]), email: String(row[11]),
          remarks: String(row[12]), createdAt: String(row[13]),
          reservationId: String(row[0]), bookingStatus: src === 'WEB' ? 'ウェブ予約' : '手動入力'
        };
      });
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
// ── ウェブ予約メール通知 ────────────────────────────────────────
// =============================================================

// 管理者メールアドレス（Script Properties の ADMIN_EMAIL で上書き可能）
const ADMIN_EMAIL_DEFAULT = 'rentalakari@gmail.com';

function getAdminEmail() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty('ADMIN_EMAIL') || ADMIN_EMAIL_DEFAULT;
}

// 日付フォーマット: "2026-03-15" → "2026年3月15日（日）"
function formatBookingDate(dateStr) {
  const DAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日（${DAY_JA[d.getDay()]}）`;
}

// オプション文字列生成
function formatOptions(options) {
  if (!options || options.length === 0) return 'なし';
  return options.map(o => typeof o === 'string' ? o : o.name).join('、');
}

// 顧客への予約確認メール
function sendConfirmationEmail(booking) {
  if (!booking.email) return;
  try {
    const dateStr  = formatBookingDate(booking.date);
    const optStr   = formatOptions(booking.options);
    const totalStr = booking.total > 0 ? `¥${booking.total.toLocaleString()}（税込）` : '来店時お見積もり';

    const subject = `【ご予約確認】きものレンタル あかり — ${dateStr} ${booking.name} 様`;
    const body = `${booking.name} 様

このたびはきものレンタル あかりにご予約いただき、ありがとうございます。
以下の内容でご予約を承りました。

━━━━━━━━━━━━━━━━━━━━━━━━━━
　ご予約内容
━━━━━━━━━━━━━━━━━━━━━━━━━━
来店日時　：${dateStr} ${booking.time}
プラン　　：${booking.plan}
人数　　　：${booking.people}
オプション：${optStr}
合計金額　：${totalStr}
予約番号　：${booking.reservationId}
━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 店舗情報
きものレンタル あかり
TEL：076-201-8119
定休日：水曜日

ご予約の確認・変更・キャンセルはこちら：
${getSiteBaseUrl() ? getSiteBaseUrl() + '/my-reservation.html?id=' + booking.reservationId : '（予約確認ページのURLは店舗スタッフにお問い合わせください）'}

当日のご来店をお待ちしております。

──────────────────────────────
※ このメールは自動送信です。ご返信はお受けできません。`;

    GmailApp.sendEmail(booking.email, subject, body);
  } catch(e) {
    Logger.log('確認メール送信エラー: ' + e.message);
  }
}

// 管理者（店舗）への新規予約通知メール
function sendAdminNotification(booking) {
  try {
    const adminEmail = getAdminEmail();
    const dateStr    = formatBookingDate(booking.date);
    const optStr     = formatOptions(booking.options);
    const totalStr   = booking.total > 0 ? `¥${booking.total.toLocaleString()}` : '来店時お見積もり';

    const subject = `【新規ウェブ予約】${dateStr} ${booking.name} 様`;
    const body = `ウェブサイトから新規予約が入りました。

━━━━━━━━━━━━━━━━━━━━━━━━━━
来店日時　：${dateStr} ${booking.time}
プラン　　：${booking.plan}
人数　　　：${booking.people}
オプション：${optStr}
合計金額　：${totalStr}
━━━━━━━━━━━━━━━━━━━━━━━━━━
お名前　　：${booking.name}
メール　　：${booking.email || '未記入'}
電話　　　：${booking.tel || '未記入'}
備考　　　：${booking.remarks || 'なし'}
━━━━━━━━━━━━━━━━━━━━━━━━━━
予約番号　：${booking.reservationId}
受付日時　：${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`;

    GmailApp.sendEmail(adminEmail, subject, body);
  } catch(e) {
    Logger.log('管理者通知メール送信エラー: ' + e.message);
  }
}

// =============================================================
// ── 定員管理 ─────────────────────────────────────────────────
// =============================================================

// 人数文字列から合計人数を取得（"女性2名・男性1名" → 3）
function parsePeopleCount(peopleStr) {
  if (!peopleStr) return 1;
  const matches = String(peopleStr).match(/(\d+)名/g) || [];
  if (matches.length === 0) return 1;
  return matches.reduce((sum, m) => sum + parseInt(m), 0);
}

// 指定日の全スロットの空き状況を返す
function getSlotAvailability(date) {
  const cached   = getCachedBookings() || [];
  const manual   = getManualSheetBookings();
  const cancelled = getCancelledIds();
  const allForDate = [...cached, ...manual].filter(b =>
    b.date === date && !cancelled.has(b.reservationId)
  );
  const result = {};
  ALL_TIMES.forEach(t => {
    const inSlot = allForDate.filter(b => b.time === t);
    const booked = inSlot.reduce((sum, b) => sum + parsePeopleCount(b.people), 0);
    result[t] = { booked, remaining: Math.max(0, SLOT_CAPACITY - booked) };
  });
  return result;
}

// =============================================================
// ── 変更・キャンセル申請 ──────────────────────────────────────
// =============================================================

function getRequestsSheet() {
  const ss = getManualSheet().getParent();
  let sheet = ss.getSheetByName('変更申請');
  if (!sheet) {
    sheet = ss.insertSheet('変更申請');
    sheet.appendRow(['requestId','bookingId','bookingName','type','status','newDate','newTime','message','submittedAt','processedAt','adminNote']);
  }
  return sheet;
}

// 予約番号 + メールアドレスで照会（WEB予約のみ）
function findCustomerBooking(id, email) {
  const data = getManualSheet().getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[0]) === id && String(row[11]).toLowerCase().trim() === email) {
      return {
        id:            String(row[0]),
        date:          row[1] instanceof Date ? Utilities.formatDate(row[1], 'Asia/Tokyo', 'yyyy-MM-dd') : String(row[1]),
        time:          row[2] instanceof Date ? Utilities.formatDate(row[2], 'Asia/Tokyo', 'HH:mm') : String(row[2]),
        name:          String(row[3]),
        plan:          String(row[4]),
        people:        String(row[6]),
        options:       JSON.parse(row[7] || '[]'),
        total:         parseInt(row[8]) || 0,
        email:         String(row[11]),
        remarks:       String(row[12]),
        reservationId: String(row[0])
      };
    }
  }
  return null;
}

// 予約IDで照会（管理者承認処理用）
function findBookingByIdFromSheet(id) {
  const data = getManualSheet().getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === id) {
      return {
        id:    String(data[i][0]),
        date:  data[i][1] instanceof Date ? Utilities.formatDate(data[i][1], 'Asia/Tokyo', 'yyyy-MM-dd') : String(data[i][1]),
        time:  data[i][2] instanceof Date ? Utilities.formatDate(data[i][2], 'Asia/Tokyo', 'HH:mm') : String(data[i][2]),
        name:  String(data[i][3]),
        plan:  String(data[i][4]),
        people: String(data[i][6]),
        total: parseInt(data[i][8]) || 0,
        email: String(data[i][11]),
        reservationId: String(data[i][0])
      };
    }
  }
  return null;
}

// シート上の予約の日時を更新（変更申請承認時）
function updateManualInSheet(id, newDate, newTime) {
  const sheet = getManualSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === id) {
      if (newDate) sheet.getRange(i + 1, 2).setValue(newDate);
      if (newTime) sheet.getRange(i + 1, 3).setValue(newTime);
      return;
    }
  }
}

// 申請を保存
function saveRequest(req) {
  getRequestsSheet().appendRow([
    req.requestId, req.bookingId, req.bookingName, req.type, req.status,
    req.newDate || '', req.newTime || '', req.message || '',
    req.submittedAt, '', ''
  ]);
}

// 特定予約の未処理申請を取得
function getPendingRequestForBooking(bookingId) {
  try {
    const data = getRequestsSheet().getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][1]) === bookingId && String(data[i][4]) === 'pending') {
        return {
          requestId:   String(data[i][0]),
          type:        String(data[i][3]),
          newDate:     String(data[i][5]),
          newTime:     String(data[i][6]),
          message:     String(data[i][7]),
          submittedAt: String(data[i][8])
        };
      }
    }
  } catch(e) {}
  return null;
}

// 申請一覧取得
function getRequestsList(statusFilter) {
  const data = getRequestsSheet().getDataRange().getValues();
  if (data.length <= 1) return [];
  return data.slice(1)
    .filter(row => row[0] && (statusFilter === 'all' || String(row[4]) === statusFilter))
    .map(row => ({
      requestId:   String(row[0]),
      bookingId:   String(row[1]),
      bookingName: String(row[2]),
      type:        String(row[3]),
      status:      String(row[4]),
      newDate:     String(row[5]),
      newTime:     String(row[6]),
      message:     String(row[7]),
      submittedAt: String(row[8]),
      processedAt: String(row[9]),
      adminNote:   String(row[10])
    }))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

// 申請を承認または却下
function processRequestById(requestId, decision, adminNote) {
  const sheet = getRequestsSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== requestId) continue;
    const bookingId = String(data[i][1]);
    const type      = String(data[i][3]);
    const newDate   = String(data[i][5]);
    const newTime   = String(data[i][6]);
    // 承認処理前にメール送信用の顧客情報を取得
    const booking = findBookingByIdFromSheet(bookingId);
    // ステータス更新
    sheet.getRange(i + 1, 5).setValue(decision === 'approve' ? 'approved' : 'rejected');
    sheet.getRange(i + 1, 10).setValue(new Date().toISOString());
    sheet.getRange(i + 1, 11).setValue(adminNote);
    // 承認時の処理
    if (decision === 'approve') {
      if (type === 'cancel') {
        deleteManualFromSheet(bookingId);
      } else if (type === 'change' && newDate) {
        updateManualInSheet(bookingId, newDate, newTime);
      }
    }
    // 顧客へ結果通知
    if (booking && booking.email) {
      sendRequestResultEmail(booking, type, decision, newDate, newTime, adminNote);
    }
    return;
  }
  throw new Error('申請が見つかりません');
}

// 申請が来たことを管理者に通知
function sendRequestNotification(booking, type, newDate, newTime, message, requestId) {
  try {
    const typeLabel = type === 'cancel' ? 'キャンセル' : '日時変更';
    const subject = `【予約${typeLabel}申請】${booking.name} 様（${booking.date}）`;
    const body = `予約の${typeLabel}申請が届きました。\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n元のご予約\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `予約番号：${booking.id}\nお名前  ：${booking.name}\n` +
      `来店日時：${formatBookingDate(booking.date)} ${booking.time}\n` +
      `プラン  ：${booking.plan}\n人数    ：${booking.people}\n` +
      (type === 'change' ? `━━━━━━━━━━━━━━━━━━━━━━━━━━\n希望する変更内容\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n新しい日時：${newDate ? formatBookingDate(newDate) : '—'}　${newTime || '—'}\n` : '') +
      (message ? `お客様メッセージ：${message}\n` : '') +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n申請番号：${requestId}\n申請日時：${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`;
    GmailApp.sendEmail(getAdminEmail(), subject, body);
  } catch(e) { Logger.log('申請通知エラー: ' + e.message); }
}

// 申請結果（承認/却下）を顧客に通知
function sendRequestResultEmail(booking, type, decision, newDate, newTime, adminNote) {
  try {
    if (!booking.email) return;
    const isApproved = decision === 'approve';
    const typeLabel  = type === 'cancel' ? 'キャンセル' : '日時変更';
    const subject = `【${typeLabel}${isApproved ? '完了' : 'お断り'}】きものレンタル あかり`;
    let body;
    if (isApproved && type === 'cancel') {
      body = `${booking.name} 様\n\nご予約のキャンセルを承りました。またのご利用をお待ちしております。\n\n予約番号：${booking.id}\n来店予定日：${formatBookingDate(booking.date)} ${booking.time}\n\nきものレンタル あかり　TEL：076-201-8119\n※ このメールは自動送信です。`;
    } else if (isApproved && type === 'change') {
      const dStr = newDate ? formatBookingDate(newDate) : formatBookingDate(booking.date);
      const tStr = newTime || booking.time;
      body = `${booking.name} 様\n\nご予約の日時変更を承りました。\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n変更後のご予約内容\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n来店日時：${dStr}　${tStr}\nプラン　：${booking.plan}\n人数　　：${booking.people}\n予約番号：${booking.id}\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nきものレンタル あかり　TEL：076-201-8119\n※ このメールは自動送信です。`;
    } else {
      body = `${booking.name} 様\n\n${typeLabel}のご申請を受け付けましたが、今回はご希望に沿えない場合がございます。\n${adminNote ? '\n店舗よりメッセージ：' + adminNote + '\n' : ''}\nご不明な点はお電話にてご連絡ください。\nきものレンタル あかり　TEL：076-201-8119\n※ このメールは自動送信です。`;
    }
    GmailApp.sendEmail(booking.email, subject, body);
  } catch(e) { Logger.log('申請結果メールエラー: ' + e.message); }
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
