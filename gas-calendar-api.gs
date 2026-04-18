// =============================================================
// Kimono Calendar API — Google Apps Script Web App
// hiroshi@akari-kanazawa.jp アカウントで作成・デプロイしてください
// =============================================================


// =============================================================
// ── 認証設定（Script Properties で管理）────────────────────
// GASエディタ → プロジェクトの設定 → スクリプトプロパティ に設定:
//   ACCESS_KEY : 公開APIキー（reserve.html の公開リクエスト用）
//   ADMIN_PIN  : 管理画面PINコード（kimono-calendar.html 用）
//   STAFF_PIN  : スタッフモード用PINコード（閲覧専用）
// =============================================================

// 顧客向けメール送信元（Gmailで送信元エイリアスとして設定済みであること）
const CUSTOMER_EMAIL_FROM = 'reserve@akari-kanazawa.jp';

function getAccessKey() {
  return PropertiesService.getScriptProperties().getProperty('ACCESS_KEY') || '';
}
// ACCESS_KEY検証。LEGACY_KEYS は通常空。
// 機密ローテーションで一時的な互換性が必要な場合のみ、ここに旧キーを追加する。
// （詳細はCLAUDE.mdの「機密情報の取り扱い」を参照）
function isValidAccessKey(key) {
  if (!key) return false;
  if (key === getAccessKey()) return true;
  const LEGACY_KEYS = [];
  return LEGACY_KEYS.indexOf(key) !== -1;
}
function getAdminPin() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || '';
}
// スタッフPINを取得（閲覧専用モード用）
function getStaffPin() {
  return PropertiesService.getScriptProperties().getProperty('STAFF_PIN') || '';
}
// 管理者セッショントークン（通常8時間有効・信頼済み端末は30日有効）
const MAX_ADMIN_SESSIONS = 10; // 同時セッション上限
const ADMIN_TOKEN_TTL_MS        = 8 * 60 * 60 * 1000;       // 通常: 8時間
const ADMIN_TRUSTED_TTL_MS      = 30 * 24 * 60 * 60 * 1000; // 信頼済み端末: 30日

/**
 * 管理者トークンを発行
 * @param {boolean} rememberDevice - true で信頼済み端末として30日有効トークンを発行
 * @param {string}  deviceId       - 端末識別UUID（同じdeviceIdの既存セッションは上書き）
 */
function generateAdminToken(rememberDevice, deviceId) {
  const props = PropertiesService.getScriptProperties();
  const token = Utilities.getUuid();
  const now = new Date().getTime();
  const ttl = rememberDevice ? ADMIN_TRUSTED_TTL_MS : ADMIN_TOKEN_TTL_MS;
  const expires = now + ttl;

  // 既存セッション読み込み・期限切れ除去
  let sessions = [];
  try {
    sessions = JSON.parse(props.getProperty('admin_sessions') || '[]');
  } catch(e) { sessions = []; }
  sessions = sessions.filter(function(s) { return s.expires > now; });

  // 同じdeviceIdの既存セッションは上書き（端末ごとに1セッションに制限）
  if (deviceId) {
    sessions = sessions.filter(function(s) { return s.deviceId !== deviceId; });
  }

  // 上限超過時は古い順に削除
  while (sessions.length >= MAX_ADMIN_SESSIONS) {
    sessions.shift();
  }

  sessions.push({
    token: token,
    expires: expires,
    deviceId: deviceId || null,
    trusted: !!rememberDevice
  });
  props.setProperty('admin_sessions', JSON.stringify(sessions));
  return token;
}

function isValidAdminToken(token) {
  if (!token) return false;
  try {
    const props = PropertiesService.getScriptProperties();
    const now = new Date().getTime();
    let sessions = JSON.parse(props.getProperty('admin_sessions') || '[]');

    // 旧形式（単一セッション）からの移行対応
    if (!Array.isArray(sessions)) {
      const old = sessions;
      if (old.token === token && now < old.expires) {
        // 旧形式で有効 → 新形式に移行
        props.setProperty('admin_sessions', JSON.stringify([old]));
        return true;
      }
      props.setProperty('admin_sessions', '[]');
      return false;
    }

    return sessions.some(function(s) { return s.token === token && now < s.expires; });
  } catch(e) { return false; }
}

// スタッフセッショントークン（8時間有効・admin_sessionsとは別管理）
const MAX_STAFF_SESSIONS = 10; // 同時セッション上限

// スタッフトークンの生成（staff_sessionsに保存、role: 'staff' を含めて返す）
function generateStaffToken() {
  const props = PropertiesService.getScriptProperties();
  const token = Utilities.getUuid();
  const now = new Date().getTime();
  const expires = now + 8 * 60 * 60 * 1000; // 8時間

  let sessions = [];
  try {
    sessions = JSON.parse(props.getProperty('staff_sessions') || '[]');
  } catch(e) { sessions = []; }
  sessions = sessions.filter(function(s) { return s.expires > now; });

  while (sessions.length >= MAX_STAFF_SESSIONS) {
    sessions.shift();
  }

  sessions.push({ token: token, expires: expires });
  props.setProperty('staff_sessions', JSON.stringify(sessions));
  return token;
}

// スタッフトークンの検証
function isValidStaffToken(token) {
  if (!token) return false;
  try {
    const props = PropertiesService.getScriptProperties();
    const now = new Date().getTime();
    let sessions = JSON.parse(props.getProperty('staff_sessions') || '[]');
    if (!Array.isArray(sessions)) {
      props.setProperty('staff_sessions', '[]');
      return false;
    }
    return sessions.some(function(s) { return s.token === token && now < s.expires; });
  } catch(e) { return false; }
}

// =============================================================
// ── PINロック管理（PCI DSS v4.0準拠：10回失敗でロック）───────
// =============================================================
const PIN_LOCK_THRESHOLD = 10;   // PCI DSS v4.0: 10回以下でロック
const PIN_LOCK_DURATION  = 1800; // ロック時間: 30分（秒）

/** ロック状態を返す。ロック中なら { locked: true, lockedUntil: ISOString } */
function getPinLockState() {
  const cache = CacheService.getScriptCache();
  const lockedUntilStr = cache.get('pin_locked_until');
  if (lockedUntilStr) {
    if (new Date() < new Date(lockedUntilStr)) {
      return { locked: true, lockedUntil: lockedUntilStr };
    }
    // ロック期限切れ → リセット
    cache.remove('pin_locked_until');
    cache.remove('pin_fail_count');
  }
  return { locked: false, lockedUntil: null };
}

/** 失敗を記録し、閾値到達でロック。{ locked, lockedUntil, attemptsLeft } を返す */
function recordPinFailure() {
  const cache = CacheService.getScriptCache();
  const count = parseInt(cache.get('pin_fail_count') || '0') + 1;
  if (count >= PIN_LOCK_THRESHOLD) {
    const lockedUntil = new Date(Date.now() + PIN_LOCK_DURATION * 1000).toISOString();
    cache.put('pin_locked_until', lockedUntil, PIN_LOCK_DURATION + 60);
    cache.put('pin_fail_count',   String(count), PIN_LOCK_DURATION + 60);
    notifyAdminError(
      'PIN_LOCKOUT',
      'PINログインが ' + count + ' 回失敗し、管理画面がロックされました',
      'ロック解除予定: ' + new Date(lockedUntil).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    );
    return { locked: true, lockedUntil: lockedUntil, attemptsLeft: 0 };
  }
  cache.put('pin_fail_count', String(count), PIN_LOCK_DURATION);
  return { locked: false, lockedUntil: null, attemptsLeft: PIN_LOCK_THRESHOLD - count };
}

/** ログイン成功時に失敗カウントをリセット */
function clearPinAttempts() {
  const cache = CacheService.getScriptCache();
  cache.remove('pin_fail_count');
  cache.remove('pin_locked_until');
}

// =============================================================
// ── メールOTP（二段階認証）────────────────────────────────────
// =============================================================
const OTP_DIGITS   = 6;
const OTP_TTL_SEC  = 600; // 10分
const OTP_MAX_FAIL = 5;   // OTP失敗上限

/** 6桁ランダム数値コードを生成 */
function generateOtp() {
  const min = Math.pow(10, OTP_DIGITS - 1);
  const max = Math.pow(10, OTP_DIGITS) - 1;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

/** OTPをキャッシュに保存してメール送信 */
function issueOtp() {
  const cache = CacheService.getScriptCache();
  const otp = generateOtp();
  cache.put('admin_otp', otp, OTP_TTL_SEC);
  cache.remove('otp_fail_count');
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const subject = '【きものレンタル あかり】管理画面 認証コード';
  const body = [
    '管理画面へのログイン認証コードをお送りします。',
    '',
    '認証コード：' + otp,
    '',
    '有効時間：10分',
    '送信時刻：' + now,
    '',
    '身に覚えのない場合は、不正アクセスの可能性があります。',
    'ご注意ください。'
  ].join('\n');
  GmailApp.sendEmail(getAdminEmail(), subject, body);
}

// =============================================================
// ── 予約フォームOTP（顧客メール確認）───────────────────────────
// =============================================================
function getBookingOtpCacheKey(email) {
  return 'botp_' + email.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 40);
}

/** 予約OTPを生成してキャッシュ保存→顧客メール送信 */
function issueBookingOtp(email) {
  const cache = CacheService.getScriptCache();
  const otp   = generateOtp();
  const key   = getBookingOtpCacheKey(email);
  cache.put(key, otp, OTP_TTL_SEC);
  cache.remove(key + '_fail');
  const subject = '【きものレンタル あかり】予約確認コード / Booking Verification Code';
  const body = [
    '以下の確認コードを予約フォームにご入力ください。',
    'Please enter the following code in the booking form.',
    '',
    '確認コード / Code：' + otp,
    '',
    '有効時間 / Valid for：10分 / 10 minutes',
    '※このコードを第三者に教えないでください。',
    '※ Do not share this code with anyone.',
    '',
    '身に覚えのない場合は、このメールを無視してください。',
    'If you did not request this, please ignore this email.'
  ].join('\n');
  GmailApp.sendEmail(email, subject, body, { from: CUSTOMER_EMAIL_FROM, name: '着物レンタル あかり' });
}

/** 予約OTP検証。{ valid, expired } を返す */
function verifyBookingOtpCode(email, inputOtp) {
  const cache = CacheService.getScriptCache();
  const key   = getBookingOtpCacheKey(email);
  const stored = cache.get(key);
  if (!stored) return { valid: false, expired: true };
  const failKey = key + '_fail';
  const fails   = parseInt(cache.get(failKey) || '0');
  if (fails >= OTP_MAX_FAIL) {
    cache.remove(key);
    cache.remove(failKey);
    return { valid: false, expired: true };
  }
  if (inputOtp !== stored) {
    cache.put(failKey, String(fails + 1), OTP_TTL_SEC);
    return { valid: false, expired: false };
  }
  cache.remove(key);
  cache.remove(failKey);
  return { valid: true };
}

/** 管理者OTP検証。{ valid, error, expired } を返す */
function verifyOtpCode(inputOtp) {
  const cache     = CacheService.getScriptCache();
  const storedOtp = cache.get('admin_otp');
  if (!storedOtp) {
    return { valid: false, error: '認証コードが期限切れです。最初からやり直してください。', expired: true };
  }
  const fails = parseInt(cache.get('otp_fail_count') || '0');
  if (fails >= OTP_MAX_FAIL) {
    cache.remove('admin_otp');
    cache.remove('otp_fail_count');
    return { valid: false, error: 'コード入力回数の上限を超えました。最初からやり直してください。', expired: true };
  }
  if (inputOtp !== storedOtp) {
    cache.put('otp_fail_count', String(fails + 1), OTP_TTL_SEC);
    return { valid: false, error: 'コードが違います（残り' + (OTP_MAX_FAIL - fails - 1) + '回）', expired: false };
  }
  // 成功 → OTP無効化
  cache.remove('admin_otp');
  cache.remove('otp_fail_count');
  return { valid: true };
}

// 電話番号の先頭0補完（スプレッドシートが数値化して0を消す対策）
// 9桁〜10桁の数字のみの場合、国内番号とみなし先頭に0を付与
function fixTel(val) {
  var s = String(val || '');
  if (/^\d{9,10}$/.test(s)) return '0' + s;
  return s;
}

// =============================================================
// ── 定員設定 ─────────────────────────────────────────────────
// 1スロット（30分）あたりの最大受入組数（人数に関わらず1予約=1組）
// =============================================================
const SLOT_CAPACITY = 1;
const ALL_TIMES = ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00'];

// =============================================================
// ── 店舗設定マスター（料金・プラン・オプション等）───────────────
// HTML側はこのデータをAPIで取得し動的に描画する。
// 変更時はここを編集して clasp push → clasp deploy のみでOK。
// =============================================================
function getShopConfig() {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const config = {
    // ── 営業情報 ──
    timeSlots: ALL_TIMES,
    closedDayOfWeek: 3,  // 0=日,1=月,...,3=水
    shopPhone: '076-201-8119',

    // ── 料金体系 ──
    malePrice: 4400,
    childPrice: 3300,

    // ── プラン定義 ──
    plans: [
      { name: 'ベーシック',   price: 2970,  isEstimate: false, badge: 'BASIC',          badgeClass: '',
        ja: { displayName: 'ベーシック',   note: 'お得に着物街歩き。あらかじめ帯もコーディネートしてあるプラン' },
        en: { displayName: 'Basic',        note: 'Best value for a kimono city stroll. Obi is pre-coordinated.' },
        zh: { displayName: '基本方案',     note: '超值和服街道漫步，腰帶已預先搭配完成。' } },
      { name: 'スタンダード', price: 3960,  isEstimate: false, badge: 'STANDARD',       badgeClass: '',
        ja: { displayName: 'スタンダード', note: '豊富なラインナップから<br>お好みの一着を' },
        en: { displayName: 'Standard',     note: 'Choose your favorite from our wide selection.' },
        zh: { displayName: '標準方案',     note: '從豐富的款式中，挑選您心儀的一套。' } },
      { name: 'プレミアム',   price: 4950,  isEstimate: false, badge: 'PREMIUM',        badgeClass: 'badge-gold',
        ja: { displayName: 'プレミアム',   note: '上質な着物・帯で<br>特別感ある装いを' },
        en: { displayName: 'Premium',      note: 'Dress in premium kimono & obi for a truly special look.' },
        zh: { displayName: '優質方案',     note: '穿上高品質和服與腰帶，感受特別的優雅。' } },
      { name: '撮影付き',    price: 2970,  isEstimate: false, badge: 'PHOTO',          badgeClass: 'badge-gold',
        ja: { displayName: '撮影付き',    note: 'スタジオやロケーション撮影希望の方向けのプラン' },
        en: { displayName: 'With Photo',  note: 'Designed for customers who want studio or location photography.' },
        zh: { displayName: '含攝影方案',  note: '適合希望進行攝影工作室或外景拍攝的顧客。' } },
      { name: '加賀友禅',    price: 41800, isEstimate: false, badge: 'KAGA YUZEN',     badgeClass: 'badge-kaga',
        ja: { displayName: '加賀友禅',    note: '伝統工芸・加賀友禅の<br>本物の美しさを体感' },
        en: { displayName: 'Kaga Yuzen',  note: 'Experience the authentic beauty of Kaga Yuzen traditional craft.' },
        zh: { displayName: '加賀友禅',   note: '親身體驗加賀友禅這項傳統工藝之美。' } },
      { name: '成人式下見',  price: 0,     isEstimate: true,  badge: 'SEIJIN-SHIKI',  badgeClass: 'badge-green',
        ja: { displayName: '成人式下見',  note: '振袖をじっくり<br>ご試着いただけます' },
        en: { displayName: 'Coming-of-Age Preview', note: 'Try on furisode at your leisure to find your perfect style.' },
        zh: { displayName: '成人式試穿',  note: '請從容地試穿振袖，找到您最喜歡的款式。' } },
      { name: '卒業式下見',  price: 0,     isEstimate: true,  badge: 'SOTSUGYOU-SHIKI', badgeClass: 'badge-green',
        ja: { displayName: '卒業式下見',  note: '袴・着物コーディネートを<br>ご提案いたします' },
        en: { displayName: 'Graduation Preview', note: "We'll help coordinate your hakama or kimono ensemble." },
        zh: { displayName: '畢業式試穿',  note: '我們將為您提供袴・和服的搭配建議。' } },
      { name: '期間限定',    price: 2970,  isEstimate: false, badge: 'LIMITED',        badgeClass: 'badge-red',
        basePlan: 'ベーシック',
        periodStart: '2026-03-01',
        periodEnd:   '2026-04-05',
        benefits: [
          { ja: '着物アップグレード無料', en: 'Free kimono upgrade', zh: '免費升級和服' },
          { ja: '翌日返却無料', en: 'Free next-day return', zh: '免費隔日歸還' }
        ],
        ja: { displayName: '学割プラン', note: '学生証ご提示で着物アップグレード＆翌日返却が無料！' },
        en: { displayName: 'Student Discount', note: 'Show your student ID for a free kimono upgrade & next-day return!' },
        zh: { displayName: '學生優惠', note: '出示學生證即可免費升級和服＆隔日歸還！' } },
    ],

    // ── オプション定義 ──
    options: [
      { name: 'スタジオ撮影（データ渡し）',             price: 4950,  qtyUnit: '回', maxQty: 1, photoOnly: true, photoRequired: true,
        en: { name: 'Studio Photo (Digital Data)',           qtyUnit: 'session' },
        zh: { name: '攝影工作室（數位檔案）',                 qtyUnit: '次' } },
      { name: 'スタジオ撮影（データ＋2Lプリント2枚）',  price: 7700,  qtyUnit: '回', maxQty: 1, photoOnly: true, photoRequired: true,
        en: { name: 'Studio Photo (Digital + 2 Prints)',     qtyUnit: 'session' },
        zh: { name: '攝影工作室（數位+2張相片）',              qtyUnit: '次' } },
      { name: 'ロケーション撮影 ブロンズ（50カット）',  price: 22000, qtyUnit: '回', maxQty: 1, photoOnly: true, photoRequired: true,
        en: { name: 'Location Photo Bronze (50 shots)',      qtyUnit: 'session' },
        zh: { name: '外景攝影 銅牌（50張）',                  qtyUnit: '次' } },
      { name: 'ロケーション撮影 シルバー（100カット）', price: 33000, qtyUnit: '回', maxQty: 1, photoOnly: true, photoRequired: true,
        en: { name: 'Location Photo Silver (100 shots)',     qtyUnit: 'session' },
        zh: { name: '外景攝影 銀牌（100張）',                 qtyUnit: '次' } },
      { name: 'ロケーション撮影 ゴールド（150カット）', price: 55000, qtyUnit: '回', maxQty: 1, photoOnly: true, photoRequired: true,
        en: { name: 'Location Photo Gold (150 shots)',       qtyUnit: 'session' },
        zh: { name: '外景攝影 金牌（150張）',                 qtyUnit: '次' } },
      { name: 'スタンダード着物', price: 990,  qtyUnit: '名', photoOnly: true, gradeOnly: true,
        en: { name: 'Standard Kimono Upgrade' }, zh: { name: '標準和服升級' } },
      { name: 'プレミアム着物',   price: 1980, qtyUnit: '名', photoOnly: true, gradeOnly: true,
        en: { name: 'Premium Kimono Upgrade' },  zh: { name: '優質和服升級' } },
      { name: 'ヘアセット',           note: '髪飾りも料金に含まれます',   price: 1650, unit: '/名', qtyUnit: '名',
        en: { name: 'Hair Styling',          note: 'Hair accessories included',         unit: '/person', qtyUnit: 'person' },
        zh: { name: '髮型設計',              note: '含髮飾',                             unit: '/名', qtyUnit: '名' } },
      { name: 'フォーマルヘアセット', note: '髪飾りも料金に含まれます',   price: 4400, unit: '/名', qtyUnit: '名', kagaOnly: true,
        en: { name: 'Formal Hair Styling',   note: 'Hair accessories included',         unit: '/person', qtyUnit: 'person' },
        zh: { name: '正式髮型設計',          note: '含髮飾',                             unit: '/名', qtyUnit: '名' } },
      { name: '髪飾り',               note: '',                            price: 550,  unit: '/個', qtyUnit: '個',
        en: { name: 'Hair Accessories',      note: '',                                  unit: '/piece', qtyUnit: 'piece' },
        zh: { name: '髮飾',                  note: '',                                  unit: '/個', qtyUnit: '個' } },
      { name: 'メンズヘアセット',     note: '美容師によるヘアセット',     price: 880,  unit: '/名', qtyUnit: '名', maleOnly: true,
        en: { name: "Men's Hair Styling",    note: 'Hair set by a professional stylist', unit: '/person', qtyUnit: 'person' },
        zh: { name: '男士髮型設計',          note: '由專業美容師提供',                    unit: '/名', qtyUnit: '名' } },
      { name: 'フルメイク',           note: '',                            price: 4400, unit: '/名', qtyUnit: '名',
        en: { name: 'Full Makeup',           note: '',                                  unit: '/person', qtyUnit: 'person' },
        zh: { name: '全臉彩妝',              note: '',                                  unit: '/名', qtyUnit: '名' } },
      { name: '名古屋帯',         note: '帯を名古屋帯に変更できます',         price: 550,  unit: '',    qtyUnit: '個',
        en: { name: 'Nagoya-obi Upgrade',    note: 'Change the obi to Nagoya-obi',      unit: '',    qtyUnit: 'item' },
        zh: { name: '升級名古屋帶',          note: '可更換為名古屋帶',                    unit: '',    qtyUnit: '個' } },
      { name: 'ぬくぬく肌着',     note: '冬の防寒用肌着（上下セット）',       price: 550,  unit: '/名', qtyUnit: '名',
        en: { name: 'Winter Thermal Wear',   note: 'Winter thermal undergarment set (top & bottom)', unit: '/person', qtyUnit: 'person' },
        zh: { name: '冬季保暖內衣',          note: '冬季保暖內衣（上下套裝）',             unit: '/名', qtyUnit: '名' } },
      { name: 'コート・ショール', note: '羽織れる防寒アイテム',               price: 550,  unit: '/名', qtyUnit: '名',
        en: { name: 'Coat / Shawl',          note: 'Wearable outerwear for cold weather', unit: '/person', qtyUnit: 'person' },
        zh: { name: '外套・披肩',            note: '禦寒外衣',                            unit: '/名', qtyUnit: '名' } },
      { name: '翌日返却',         note: 'お客様が持ち出し→翌日返却（火曜日来店は選択不可）', price: 1100, unit: '', qtyUnit: '個',
        en: { name: 'Next-day Return',       note: 'You take home & return the next day (not available on Tue visits)', unit: '', qtyUnit: 'item' },
        zh: { name: '隔日歸還',              note: '顧客帶回後隔日歸還（週二來店不可選）', unit: '', qtyUnit: '個' } },
      { name: 'ホテル返却',       note: 'スタッフがホテルまでお届け。フロントに返却。（火曜日来店は選択不可）', price: 1650, unit: '', qtyUnit: '個',
        en: { name: 'Hotel Return',          note: 'Staff delivers to hotel; return at front desk (not available on Tue visits)', unit: '', qtyUnit: 'item' },
        zh: { name: '飯店歸還',              note: '工作人員送至飯店，於前台歸還（週二來店不可選）', unit: '', qtyUnit: '個' } },
      { name: '人力車',           note: '30分コース。コースは事前相談可能。',  price: 8800, unit: '/台（2名）', qtyUnit: '台', wide: true,
        en: { name: 'Rickshaw Ride',         note: '30-min course. Route can be discussed in advance.', unit: '/vehicle (2 persons)', qtyUnit: 'vehicle' },
        zh: { name: '人力車體驗',            note: '30分鐘路線，可事先商量路線。',          unit: '/台（2名）', qtyUnit: '台' } },
      { name: '観光タクシー',     note: '2時間乗り放題。コースはドライバーにお申し出ください。', price: 9900, unit: '/台（4名）', qtyUnit: '台', wide: true,
        en: { name: 'Sightseeing Taxi',      note: '2-hour unlimited ride. Ask the driver for course options.', unit: '/vehicle (4 persons)', qtyUnit: 'vehicle' },
        zh: { name: '觀光計程車',            note: '2小時暢遊，路線請告知司機。',           unit: '/台（4名）', qtyUnit: '台' } },
    ],

    // ── 管理画面用オプション定義（kimono-booking.html）──
    adminOptions: [
      { id: 'o1',  name: 'スタンダード着物にアップグレード',     plans: ['ベーシック','期間限定'],                     price: 990 },
      { id: 'o2a', name: 'プレミアム着物にアップグレード（ベーシック/期間限定から）', plans: ['ベーシック','期間限定'], price: 1980 },
      { id: 'o2b', name: 'プレミアム着物にアップグレード（スタンダードから）',       plans: ['スタンダード'],         price: 990 },
      { id: 'o3',  name: 'ヘアセット',           plans: null, notForPlans: ['加賀友禅'], price: 1650 },
      { id: 'o18', name: 'フォーマルヘアセット', plans: ['加賀友禅'],                    price: 4400 },
      { id: 'o16', name: '髪飾り',               plans: null,                            price: 550  },
      { id: 'o4',  name: 'メンズヘアセット',     plans: null,                            price: 880  },
      { id: 'o19', name: 'フルメイク',           plans: null,                            price: 4400 },
      { id: 'o17', name: '名古屋帯',             plans: null,                            price: 550 },
      { id: 'o5',  name: 'ぬくぬく肌着',         plans: null,                            price: 550 },
      { id: 'o6',  name: 'コート・ショール',     plans: null,                            price: 550 },
      { id: 'o7',  name: '翌日返却',             plans: null,                            price: 1100 },
      { id: 'o8',  name: 'ホテル返却',           plans: null,                            price: 1650 },
      { id: 'o9',  name: '人力車',               plans: null,                            price: 8800 },
      { id: 'o10', name: 'タクシー',             plans: null,                            price: 9900 },
      { id: 'o11', name: 'スタジオ撮影データ渡し',               plans: null, price: 4950,  aliases: ['フォトスタジオ【データ渡し】'] },
      { id: 'o12', name: 'スタジオ撮影データ＋プリント',         plans: null, price: 7700,  aliases: ['プリント渡し'] },
      { id: 'o13', name: 'ロケーション撮影ブロンズ50枚渡し',     plans: null, price: 22000, aliases: ['ブロンズプラン'] },
      { id: 'o14', name: 'ロケーション撮影シルバー100枚渡し',    plans: null, price: 33000, aliases: ['シルバープラン'] },
      { id: 'o15', name: 'ロケーション撮影ゴールド150枚渡し',    plans: null, price: 55000, aliases: ['ゴールドプラン'] },
    ],
  };

  // ── 期間限定プランのフィルタリング＋並び替え ──
  config.plans = config.plans.filter(function(p) {
    if (!p.periodEnd) return true; // 期間設定なし → 常時表示
    if (p.periodStart && today < p.periodStart) return false; // 開始前
    if (p.periodEnd   && today > p.periodEnd)   return false; // 終了後
    return true;
  });
  // 期間限定プランを先頭に移動
  config.plans.sort(function(a, b) {
    const aLimited = a.periodEnd ? 0 : 1;
    const bLimited = b.periodEnd ? 0 : 1;
    return aLimited - bLimited;
  });

  return config;
}

// =============================================================
// ── サーバーサイド金額検証 ────────────────────────────────────
// =============================================================
/**
 * クライアントから送信された予約の金額をサーバー側で再計算・検証する
 * @param {Object} booking - 予約オブジェクト
 * @returns {{ valid: boolean, serverTotal: number, reason?: string }}
 */
function validateBookingTotal(booking) {
  if (!booking || !booking.plan) return { valid: false, serverTotal: 0, reason: 'プラン未指定' };

  const config = getShopConfig();

  // プラン検索
  const planDef = config.plans.find(function(p) { return p.name === booking.plan; });
  if (!planDef) return { valid: false, serverTotal: 0, reason: '不明なプラン: ' + booking.plan };

  // 見積もりプラン（成人式下見等）は金額検証スキップ
  if (planDef.isEstimate) return { valid: true, serverTotal: 0 };

  // 人数パース（'女性1名・男性2名・小人1名' 形式）
  var female = 0, male = 0, child = 0;
  var peopleStr = String(booking.people || '');
  var fm = peopleStr.match(/女性(\d+)/);
  var mm = peopleStr.match(/男性(\d+)/);
  var cm = peopleStr.match(/小人(\d+)/);
  if (fm) female = parseInt(fm[1]);
  if (mm) male   = parseInt(mm[1]);
  if (cm) child  = parseInt(cm[1]);
  if (female + male + child === 0) return { valid: false, serverTotal: 0, reason: '人数不正' };

  // 基本料金
  var baseTotal = planDef.price * female + config.malePrice * male + config.childPrice * child;

  // オプション料金
  var optTotal = 0;
  var bookingOpts = booking.options || [];
  for (var i = 0; i < bookingOpts.length; i++) {
    var opt = bookingOpts[i];
    var optName = String(opt.name || '');
    var optPrice = parseInt(opt.price) || 0;

    // 特典（★付き）は price=0 であることを検証
    if (optName.indexOf('★') === 0) {
      if (optPrice !== 0) return { valid: false, serverTotal: 0, reason: '特典の価格が不正: ' + optName };
      continue;
    }

    // オプション名から数量を抽出（'ヘアセット×2' 形式）
    var qtyMatch = optName.match(/×(\d+)$/);
    var qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
    var baseName = qtyMatch ? optName.replace(/×\d+$/, '') : optName;

    // オプション定義から正しい単価を取得
    var optDef = config.options.find(function(o) { return o.name === baseName; });
    if (!optDef) {
      return { valid: false, serverTotal: 0, reason: '不正なオプション: ' + baseName };
    }

    var expectedPrice = optDef.price * qty;
    if (optPrice !== expectedPrice) {
      return { valid: false, serverTotal: 0, reason: 'オプション価格不一致: ' + baseName + ' expected=' + expectedPrice + ' got=' + optPrice };
    }
    optTotal += expectedPrice;
  }

  var serverTotal = baseTotal + optTotal;

  // ポイント・クーポン控除
  if (booking.pointUsed && parseInt(booking.pointUsed) > 0) {
    serverTotal -= parseInt(booking.pointUsed);
  }
  if (booking.couponUsed && parseInt(booking.couponUsed) > 0) {
    serverTotal -= parseInt(booking.couponUsed);
  }

  // 0円未満にならないように
  if (serverTotal < 0) serverTotal = 0;

  var clientTotal = parseInt(booking.total) || 0;
  if (clientTotal !== serverTotal) {
    return { valid: false, serverTotal: serverTotal, reason: '合計不一致: server=' + serverTotal + ' client=' + clientTotal };
  }

  return { valid: true, serverTotal: serverTotal };
}

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

  // キー認証（公開エンドポイントのみ）
  if (!e || !isValidAccessKey(e.parameter.key)) {
    output.setContent(JSON.stringify({ success: false, error: 'Unauthorized' }));
    return output;
  }

  const action = e.parameter.action;

  // ── 店舗設定（公開・認証不要の情報） ──────────────────────────
  if (action === 'getConfig') {
    try {
      const config = getShopConfig();
      output.setContent(JSON.stringify({ success: true, config }));
    } catch(err) {
      output.setContent(JSON.stringify({ success: false, error: err.message }));
    }
    return output;
  }

  // ── 公開エンドポイント（顧客向け・ACCESS_KEY のみ） ──────────
  if (action === 'getAvailability') {
    try {
      const date = e.parameter.date;
      if (!date) throw new Error('date required');
      const avail = getAvailabilityForDate(date);
      output.setContent(JSON.stringify({ success: true, ...avail }));
    } catch(err) {
      output.setContent(JSON.stringify({ success: false, error: err.message }));
    }
    return output;
  }
  if (action === 'getMonthAvailability') {
    try {
      const year  = parseInt(e.parameter.year);
      const month = parseInt(e.parameter.month);
      if (!year || !month) throw new Error('year and month required');
      const daysInMonth  = new Date(year, month, 0).getDate();
      const allSettings  = getAllSettings();
      const totalSlots   = ALL_TIMES.length;
      const _cachedM = getCachedBookings();
      let gasBookings = (_cachedM && _cachedM.length > 0) ? _cachedM : getRawBookings();
      const cancelled = getCancelledIds();
      const manualBookings = getManualSheetBookings();
      const allBlocked = getAllBlockedSlotsMap();
      const result = {};
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const ds = allSettings[dateStr] || {};
        const closed = ds.closed === true;
        const limit = ds.limit != null ? ds.limit : totalSlots;
        const bookedForDate = [
          ...gasBookings.filter(b => b.date === dateStr && !cancelled.has(b.reservationId)),
          ...manualBookings.filter(b => b.date === dateStr)
        ];
        const blockedForDate = allBlocked[dateStr] || new Set();
        const occupiedSet = new Set([
          ...bookedForDate.map(b => b.time),
          ...blockedForDate
        ]);
        result[dateStr] = { closed, limit, available: Math.max(0, limit - occupiedSet.size) };
      }
      output.setContent(JSON.stringify({ success: true, availability: result }));
    } catch(err) {
      output.setContent(JSON.stringify({ success: false, error: err.message }));
    }
    return output;
  }
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
  if (action === 'submitRequest') {
    try {
      const id      = e.parameter.id;
      const email   = (e.parameter.email || '').toLowerCase().trim();
      const type    = e.parameter.type;
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

  // 管理者アクションは doPost() + トークン認証に移行済み
  output.setContent(JSON.stringify({ success: false, error: 'Use POST for admin actions' }));
  return output;
}

// =============================================================
// ── 確定予約を取得（キャンセル除外なし・キャッシュ用） ──────────
// =============================================================
function getRawBookings() {
  const jaran = getJaranBookings();
  const aj    = getActivityJapanBookings();
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const gmailBookings = [...jaran, ...aj].filter(b => b.date >= today);

  // ── Gmail解析結果をスプレッドシートに永続保存 ──
  try {
    const syncResult = syncExternalBookingsToSheet(gmailBookings);
    if (syncResult.added > 0 || syncResult.updated > 0) {
      Logger.log('外部予約永続化: +' + syncResult.added + ' / ↻' + syncResult.updated);
    }
  } catch(e) {
    Logger.log('外部予約永続化エラー: ' + e.message);
  }

  // ── 外部予約シートから読み込み、Gmailで取得できなかった予約を補完 ──
  const sheetBookings = getExternalSheetBookings();
  const gmailIds = new Set(gmailBookings.map(b => b.reservationId));
  const recovered = sheetBookings.filter(b => !gmailIds.has(b.reservationId));
  if (recovered.length > 0) {
    Logger.log('外部予約シートから補完: ' + recovered.length + '件（Gmailで取得できなかった予約）');
    logAudit('RECOVER_FROM_SHEET', {
      count: recovered.length,
      ids: recovered.map(b => b.reservationId).join(', ')
    });
  }

  // ── Supabase から WEB予約（reserve.html経由）を取得 ──
  // 4/14のSupabase移行以降、WEB予約は Supabase only に保存される。
  // Gmail/シート には来ないので、ここで Supabase から直接読む。
  const webBookings = getWebBookingsFromSupabase();
  if (webBookings.length > 0) {
    Logger.log('Supabase WEB予約: ' + webBookings.length + '件');
  }

  const merged = [...gmailBookings, ...recovered, ...webBookings];
  logAudit('SYNC', {
    gmail: gmailBookings.length,
    recovered: recovered.length,
    web: webBookings.length,
    total: merged.length,
    count: merged.length
  });

  return merged.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.time.localeCompare(b.time);
  });
}

/**
 * Supabase から WEB予約（reserve.html経由）を取得して GAS形式に変換。
 * source='WEB' かつ 今日以降のみ。Service Role KeyでRLSをバイパス。
 * 失敗してもエラーは投げず空配列を返す（GAS全体の停止を防ぐ）。
 */
function getWebBookingsFromSupabase() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('SUPABASE_URL');
  const key = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    Logger.log('Supabase WEB予約取得スキップ: SUPABASE_URL/KEY が未設定');
    return [];
  }

  try {
    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    const endpoint = url + '/rest/v1/bookings?source=eq.WEB&date=gte.' + today + '&select=*&order=date.asc';
    const resp = UrlFetchApp.fetch(endpoint, {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + key, 'apikey': key },
      muteHttpExceptions: true
    });

    const code = resp.getResponseCode();
    if (code >= 400) {
      Logger.log('Supabase WEB予約取得エラー (HTTP ' + code + '): ' + resp.getContentText().substring(0, 200));
      return [];
    }

    const data = JSON.parse(resp.getContentText());
    if (!Array.isArray(data)) return [];

    // Supabase形式 → GAS形式に変換
    return data.map(function(b) {
      return {
        id: b.id || b.reservation_id,
        reservationId: b.reservation_id || b.id,
        source: 'WEB',
        date: b.date,
        time: b.time,
        name: b.name,
        email: b.email || '',
        tel: b.tel || '',
        plan: b.plan || 'ベーシック',
        people: b.people || '',
        options: b.options || [],
        total: b.total || 0,
        payment: b.payment || '',
        remarks: b.remarks || '',
        visitChargeId: b.charge_id || '',
        visitStatus: b.visit_status || 'confirmed',
        channel: b.channel || 'WEB',
        createdAt: b.created_at || new Date().toISOString(),
        bookingStatus: 'ウェブ予約'
      };
    });
  } catch(e) {
    Logger.log('Supabase WEB予約取得例外: ' + e.message);
    return [];
  }
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
  // ※ activity-japan@activityjapan.com は変更通知なども送信する場合があるため、
  //   メール本文にキャンセル関連ワードがある場合のみ予約番号を取得する
  try {
    const threads = GmailApp.search('from:activity-japan@activityjapan.com', 0, 200);
    for (const thread of threads) {
      for (const msg of thread.getMessages()) {
        const body = msg.getPlainBody();
        // キャンセル・取消の文言がない場合はスキップ（変更通知メールを誤って除外しない）
        if (!body.match(/キャンセル|取消|取り消し|解除|ご予約を.*キャンセル/)) continue;
        const m = body.match(/予約番号[：:]\s*(\d+)/);
        if (m) {
          ids.add(m[1]);
          Logger.log('AJキャンセル確認: #' + m[1]);
        }
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
    // subject フィルタを除去: AJが件名を「確定予約通知」→「即時確定予約通知」に変更したため
    // subject:確定予約通知 では「即時確定予約通知」がGmailの日本語トークナイザでマッチしない
    // parseAJEmail() が予約番号+日時を必須チェックするので、無関係メールは自動除外される
    const newThreads = GmailApp.search(
      'from:reserve-system@activityjapan.com', 0, 200
    );
    Logger.log('AJ確定メール: スレッド' + newThreads.length + '件');
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
    // subject フィルタを除去: 日本語トークナイザの問題でマッチしない場合があるため
    // parseAJChangeEmail() が予約番号+実施日を必須チェックするので無関係メールは自動除外される
    const changeThreads = GmailApp.search(
      '(from:activity-japan@activityjapan.com OR from:reserve-system@activityjapan.com)', 0, 200
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
    if (!idMatch) { Logger.log('AJ変更メール: 予約番号が見つかりません'); return null; }
    const reservationId = idMatch[1];

    // 実施日: 「アクティビティ実施日時：」or「アクティビティ実施日：」（時 の有無を許容）
    // → 旧コードは「実施日：」しか対応していなかったため「実施日時：」で null を返していたバグを修正
    const dateMatch = body.match(/アクティビティ実施日(?:時)?[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/)
      // フォールバック: 本文先頭行「2026年04月04日：プラン名…」形式
      || body.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日[：:]/m);
    if (!dateMatch) { Logger.log('AJ変更メール(#' + reservationId + '): 実施日が見つかりません'); return null; }
    const date = dateMatch[1] + '-'
      + String(dateMatch[2]).padStart(2, '0') + '-'
      + String(dateMatch[3]).padStart(2, '0');

    // 時刻: 「コース名：11:30コース」形式
    // フォールバック: 括弧内「（11:30）」形式（確定メールと同じ形式になった場合）
    const timeMatch = body.match(/コース名[：:]\s*(\d{2}:\d{2})/)
      || body.match(/[（(](\d{2}:\d{2})\s*[）)]/);
    const time = timeMatch ? timeMatch[1] : '00:00';
    if (!timeMatch) Logger.log('AJ変更メール(#' + reservationId + '): 時刻が見つかりません（00:00 を使用）');

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
    sheet.appendRow(['id','date','time','name','plan','channel','people','options','total','payment','tel','email','remarks','createdAt','visitStatus','visitChargeId','statusUpdatedAt']);
  }
  return sheet;
}

function getManualSheetBookings(includePast) {
  try {
    const sheet = getManualSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];
    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    return data.slice(1)
      .filter(row => {
        if (!row[0]) return false;
        if (includePast) return true;
        const d = row[1] instanceof Date
          ? Utilities.formatDate(row[1], 'Asia/Tokyo', 'yyyy-MM-dd')
          : String(row[1]);
        return d >= today;
      })
      .map(row => {
        const src = String(row[5]) === 'ウェブサイト' && String(row[0]).startsWith('HP-') ? 'WEB' : 'MANUAL';
        const vs = String(row[14] || 'confirmed');
        return {
          id: String(row[0]), source: src,
          date: row[1] instanceof Date ? Utilities.formatDate(row[1], 'Asia/Tokyo', 'yyyy-MM-dd') : String(row[1]),
          time: row[2] instanceof Date ? Utilities.formatDate(row[2], 'Asia/Tokyo', 'HH:mm') : String(row[2]),
          name: String(row[3]), plan: String(row[4]),
          channel: String(row[5]), people: String(row[6]),
          options: JSON.parse(row[7] || '[]'),
          total: parseInt(row[8]) || 0,
          payment: String(row[9]), tel: fixTel(row[10]), email: String(row[11]),
          remarks: String(row[12]), createdAt: String(row[13]),
          reservationId: String(row[0]), bookingStatus: src === 'WEB' ? 'ウェブ予約' : '手動入力',
          visitStatus: vs === '' ? 'confirmed' : vs,
          visitChargeId: String(row[15] || ''),
          statusUpdatedAt: String(row[16] || '')
        };
      });
  } catch(e) { Logger.log('手動予約取得エラー: ' + e.message); return []; }
}

// 指定月の手動予約を取得（過去月表示用）
function getManualSheetBookingsForMonth(year, month) {
  const prefix = year + '-' + String(month).padStart(2, '0');
  try {
    const sheet = getManualSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];
    return data.slice(1)
      .filter(function(row) {
        if (!row[0]) return false;
        const d = row[1] instanceof Date
          ? Utilities.formatDate(row[1], 'Asia/Tokyo', 'yyyy-MM-dd')
          : String(row[1]);
        return d.substring(0, 7) === prefix;
      })
      .map(function(row) {
        const src = String(row[5]) === 'ウェブサイト' && String(row[0]).startsWith('HP-') ? 'WEB' : 'MANUAL';
        const vs = String(row[14] || 'confirmed');
        return {
          id: String(row[0]), source: src,
          date: row[1] instanceof Date ? Utilities.formatDate(row[1], 'Asia/Tokyo', 'yyyy-MM-dd') : String(row[1]),
          time: row[2] instanceof Date ? Utilities.formatDate(row[2], 'Asia/Tokyo', 'HH:mm') : String(row[2]),
          name: String(row[3]), plan: String(row[4]),
          channel: String(row[5]), people: String(row[6]),
          options: JSON.parse(row[7] || '[]'),
          total: parseInt(row[8]) || 0,
          payment: String(row[9]), tel: fixTel(row[10]), email: String(row[11]),
          remarks: String(row[12]), createdAt: String(row[13]),
          reservationId: String(row[0]), bookingStatus: src === 'WEB' ? 'ウェブ予約' : '手動入力',
          visitStatus: vs === '' ? 'confirmed' : vs,
          visitChargeId: String(row[15] || ''),
          statusUpdatedAt: String(row[16] || '')
        };
      });
  } catch(e) { Logger.log('手動予約(月別)取得エラー: ' + e.message); return []; }
}

function saveManualToSheet(booking) {
  const sheet = getManualSheet();
  sheet.appendRow([
    booking.id, booking.date, booking.time, booking.name, booking.plan,
    booking.channel || '', booking.people,
    JSON.stringify(booking.options || []),
    booking.total || 0, booking.payment || '',
    booking.tel || '', booking.email || '',
    booking.remarks || '', booking.createdAt,
    booking.visitStatus || 'confirmed',
    booking.chargeId || '',
    ''
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
// ── 外部予約（AJ/じゃらん）永続ストレージ ─────────────────────
// Gmail検索ウィンドウ外の予約が消失するのを防ぐため、
// AJ/じゃらんの予約をスプレッドシートに永続保存する
// =============================================================
function getExternalBookingsSheet() {
  const ss = getManualSheet().getParent();
  let sheet = ss.getSheetByName('外部予約');
  if (!sheet) {
    sheet = ss.insertSheet('外部予約');
    sheet.appendRow([
      'reservationId', 'source', 'id', 'date', 'time', 'name',
      'plan', 'people', 'options', 'total', 'payment',
      'email', 'tel', 'remarks', 'bookingStatus', 'createdAt', 'savedAt'
    ]);
    Logger.log('外部予約シートを作成しました');
  }
  return sheet;
}

/**
 * 外部予約シートから予約を読み込む（今日以降のみ）
 */
function getExternalSheetBookings() {
  try {
    const sheet = getExternalBookingsSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];
    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    return data.slice(1)
      .filter(row => {
        if (!row[0]) return false;
        const d = row[3] instanceof Date
          ? Utilities.formatDate(row[3], 'Asia/Tokyo', 'yyyy-MM-dd')
          : String(row[3]);
        return d >= today;
      })
      .map(row => ({
        reservationId: String(row[0]),
        source:        String(row[1]),
        id:            String(row[2]),
        date:          row[3] instanceof Date ? Utilities.formatDate(row[3], 'Asia/Tokyo', 'yyyy-MM-dd') : String(row[3]),
        time:          row[4] instanceof Date ? Utilities.formatDate(row[4], 'Asia/Tokyo', 'HH:mm') : String(row[4]),
        name:          String(row[5]),
        plan:          String(row[6]),
        people:        String(row[7]),
        options:       JSON.parse(row[8] || '[]'),
        total:         parseInt(row[9]) || 0,
        payment:       String(row[10]),
        email:         String(row[11]),
        tel:           fixTel(row[12]),
        remarks:       String(row[13]),
        bookingStatus: String(row[14]),
        createdAt:     String(row[15])
      }));
  } catch(e) {
    Logger.log('外部予約取得エラー: ' + e.message);
    return [];
  }
}

// 指定月の外部予約（AJ/じゃらん）を取得（過去月表示用）
function getExternalSheetBookingsForMonth(year, month) {
  const prefix = year + '-' + String(month).padStart(2, '0');
  try {
    const sheet = getExternalBookingsSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];
    return data.slice(1)
      .filter(function(row) {
        if (!row[0]) return false;
        const d = row[3] instanceof Date
          ? Utilities.formatDate(row[3], 'Asia/Tokyo', 'yyyy-MM-dd')
          : String(row[3]);
        return d.substring(0, 7) === prefix;
      })
      .map(function(row) {
        return {
          reservationId: String(row[0]),
          source:        String(row[1]),
          id:            String(row[2]),
          date:          row[3] instanceof Date ? Utilities.formatDate(row[3], 'Asia/Tokyo', 'yyyy-MM-dd') : String(row[3]),
          time:          row[4] instanceof Date ? Utilities.formatDate(row[4], 'Asia/Tokyo', 'HH:mm') : String(row[4]),
          name:          String(row[5]),
          plan:          String(row[6]),
          people:        String(row[7]),
          options:       JSON.parse(row[8] || '[]'),
          total:         parseInt(row[9]) || 0,
          payment:       String(row[10]),
          email:         String(row[11]),
          tel:           fixTel(row[12]),
          remarks:       String(row[13]),
          bookingStatus: String(row[14]),
          createdAt:     String(row[15])
        };
      });
  } catch(e) {
    Logger.log('外部予約(月別)取得エラー: ' + e.message);
    return [];
  }
}

/**
 * Gmail から解析した AJ/じゃらん予約をスプレッドシートに同期
 * - 新規予約 → 追加
 * - 既存予約の変更（bookingStatus='変更済' or 内容差分あり） → 行を更新
 * - 戻り値: { added: N, updated: N }
 */
function syncExternalBookingsToSheet(gmailBookings) {
  if (!gmailBookings || gmailBookings.length === 0) return { added: 0, updated: 0 };

  const sheet = getExternalBookingsSheet();
  const data = sheet.getDataRange().getValues();
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  // 既存の reservationId → 行番号（1-indexed）のマップ
  const existingMap = {};
  for (let i = 1; i < data.length; i++) {
    const rid = String(data[i][0]);
    if (rid) existingMap[rid] = i + 1; // シート行番号（1-indexed）
  }

  let added = 0;
  let updated = 0;

  for (const b of gmailBookings) {
    if (!b.reservationId) continue;
    const rowData = [
      b.reservationId, b.source || '', b.id || '',
      b.date || '', b.time || '', b.name || '',
      b.plan || '', b.people || '',
      JSON.stringify(b.options || []),
      b.total || 0, b.payment || '',
      b.email || '', b.tel || '', b.remarks || '',
      b.bookingStatus || '', b.createdAt || '', now
    ];

    const existingRow = existingMap[b.reservationId];
    if (existingRow) {
      // 既存の行と比較し、変更があれば更新
      const oldRow = data[existingRow - 1]; // 0-indexed
      const oldDate = String(oldRow[3]);
      const oldTime = String(oldRow[4]);
      const oldStatus = String(oldRow[14]);
      const oldTotal = parseInt(oldRow[9]) || 0;
      if (b.date !== oldDate || b.time !== oldTime || b.bookingStatus !== oldStatus || b.total !== oldTotal) {
        sheet.getRange(existingRow, 1, 1, rowData.length).setValues([rowData]);
        updated++;
        logAudit('UPDATE_EXTERNAL', {
          reservationId: b.reservationId, source: b.source,
          changes: `date:${oldDate}→${b.date}, time:${oldTime}→${b.time}, status:${oldStatus}→${b.bookingStatus}`
        });
      }
    } else {
      // 新規追加
      sheet.appendRow(rowData);
      added++;
      logAudit('ADD_EXTERNAL', {
        reservationId: b.reservationId, source: b.source,
        date: b.date, time: b.time, name: b.name
      });
    }
  }

  if (added > 0 || updated > 0) {
    Logger.log('外部予約同期: 追加=' + added + ', 更新=' + updated);
  }
  return { added, updated };
}

// =============================================================
// ── 監査ログ（変更ログ） ──────────────────────────────────────
// =============================================================
function getAuditLogSheet() {
  const ss = getManualSheet().getParent();
  let sheet = ss.getSheetByName('変更ログ');
  if (!sheet) {
    sheet = ss.insertSheet('変更ログ');
    sheet.appendRow(['timestamp', 'action', 'details', 'bookingCount']);
    Logger.log('変更ログシートを作成しました');
  }
  return sheet;
}

/**
 * 監査ログに1行追加
 * @param {string} action - アクション種別 (ADD_EXTERNAL, UPDATE_EXTERNAL, SYNC, CACHE_REFRESH, etc.)
 * @param {object} data   - 詳細データ
 */
function logAudit(action, data) {
  try {
    const sheet = getAuditLogSheet();
    const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    const details = typeof data === 'string' ? data : JSON.stringify(data);
    const count = (data && data.count !== undefined) ? data.count : '';
    sheet.appendRow([now, action, details, count]);
  } catch(e) {
    Logger.log('監査ログ書き込みエラー: ' + e.message);
  }
}

// =============================================================
// ── スロットブロック管理 ───────────────────────────────────────
// =============================================================
function getBlockedSlotsSheet() {
  const ss = getManualSheet().getParent();
  let sheet = ss.getSheetByName('スロットブロック');
  if (!sheet) {
    sheet = ss.insertSheet('スロットブロック');
    sheet.appendRow(['date', 'time', 'reason']);
  }
  return sheet;
}

// 指定日のブロック済みスロット一覧
function getBlockedSlotsList(date) {
  const sheet = getBlockedSlotsSheet();
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  return data.slice(1)
    .filter(row => String(row[0]) === date)
    .map(row => ({ time: String(row[1]), reason: String(row[2] || '') }));
}

// 月次集計用: 全日のブロック済みスロットをマップで返す { date: Set<time> }
function getAllBlockedSlotsMap() {
  const sheet = getBlockedSlotsSheet();
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return {};
  const result = {};
  data.slice(1).forEach(row => {
    const date = String(row[0]);
    const time = String(row[1]);
    if (!result[date]) result[date] = new Set();
    result[date].add(time);
  });
  return result;
}

// スロットをブロック（既存なら reason を更新）
function blockSlotInSheet(date, time, reason) {
  const sheet = getBlockedSlotsSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === date && String(data[i][1]) === time) {
      sheet.getRange(i + 1, 3).setValue(reason || '');
      return;
    }
  }
  sheet.appendRow([date, time, reason || '']);
}

// スロットブロックを解除
function unblockSlotInSheet(date, time) {
  const sheet = getBlockedSlotsSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === date && String(data[i][1]) === time) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

// =============================================================
// ── 設定シート管理 ────────────────────────────────────────────
// =============================================================
function getSettingsSheet() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  const ssId = props.getProperty('manual_ss_id');
  if (ssId) {
    try { ss = SpreadsheetApp.openById(ssId); } catch(e) { ss = null; }
  }
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    ss = SpreadsheetApp.create('着物カレンダー_手動予約');
    props.setProperty('manual_ss_id', ss.getId());
  }
  let sheet = ss.getSheetByName('設定');
  if (!sheet) {
    sheet = ss.insertSheet('設定');
    sheet.appendRow(['date', 'limit', 'closed', 'note', 'photoLimit', 'photoBlockedSlots', 'blockedSlots']);
    sheet.appendRow(['DEFAULT', ALL_TIMES.length, 'FALSE', 'デフォルト上限', 2, '', '']);
  } else {
    const rows = sheet.getDataRange().getValues();
    const header = rows[0] || [];
    // 既存シートにphotoLimit列がなければ追加（マイグレーション）
    if (header.length < 6 || String(header[4]) !== 'photoLimit') {
      sheet.getRange(1, 5).setValue('photoLimit');
      sheet.getRange(1, 6).setValue('photoBlockedSlots');
      Logger.log('設定シートにphotoLimit/photoBlockedSlots列を追加しました');
    }
    // blockedSlots列（G列）がなければ追加（マイグレーション）
    if (header.length < 7 || String(header[6]) !== 'blockedSlots') {
      sheet.getRange(1, 7).setValue('blockedSlots');
      Logger.log('設定シートにblockedSlots列を追加しました');
    }
    // DEFAULT上限が旧バグ値(2)のままなら正しい値(11)に自動マイグレーション
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === 'DEFAULT' && (rows[i][1] === 2 || rows[i][1] === '2')) {
        sheet.getRange(i + 1, 2).setValue(ALL_TIMES.length);
        Logger.log('DEFAULT上限を旧バグ値2→' + ALL_TIMES.length + 'に自動修正しました');
        break;
      }
    }
  }
  return sheet;
}

function getAllSettings() {
  try {
    const sheet = getSettingsSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return {};
    const result = {};
    data.slice(1).forEach(row => {
      const date  = normalizeSettingsDate(row[0]);
      const limit = (row[1] !== '' && row[1] !== null && !isNaN(row[1])) ? parseInt(row[1]) : null;
      const closed = String(row[2]).toUpperCase() === 'TRUE' || row[2] === true;
      const note  = String(row[3] || '');
      const photoLimit = (row[4] !== '' && row[4] !== null && row[4] !== undefined && !isNaN(row[4])) ? parseInt(row[4]) : null;
      const photoBlockedSlots = row[5] ? String(row[5]).split(',').map(function(s){return s.trim();}).filter(Boolean) : [];
      const blockedSlots = row[6] ? String(row[6]).split(',').map(function(s){return s.trim();}).filter(Boolean) : [];
      result[date] = { limit, closed, note, photoLimit, photoBlockedSlots, blockedSlots };
    });
    return result;
  } catch(e) {
    Logger.log('設定取得エラー: ' + e.message);
    return {};
  }
}

function normalizeSettingsDate(val) {
  if (val instanceof Date) return Utilities.formatDate(val, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(val);
}

function saveSettingsToSheet(date, limit, closed, note, photoLimit, photoBlockedSlots, blockedSlots) {
  const sheet = getSettingsSheet();
  const data  = sheet.getDataRange().getValues();
  const row = [date, limit !== null ? limit : '', closed ? 'TRUE' : 'FALSE', note || '',
               photoLimit !== null && photoLimit !== undefined ? photoLimit : '', photoBlockedSlots || '', blockedSlots || ''];
  for (let i = 1; i < data.length; i++) {
    if (normalizeSettingsDate(data[i][0]) === date) {
      sheet.getRange(i + 1, 1, 1, 7).setValues([row]);
      return;
    }
  }
  sheet.appendRow(row);
}

function deleteSettingsFromSheet(date) {
  const sheet = getSettingsSheet();
  const data  = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (normalizeSettingsDate(data[i][0]) === date) {
      sheet.deleteRow(i + 1);
    }
  }
}

function getAvailabilityForDate(date) {
  const settings    = getAllSettings();
  const dateSetting = settings[date] || {};
  const totalSlots  = ALL_TIMES.length; // 1日のタイムスロット総数

  const closed = dateSetting.closed === true;
  // 管理者が上限を設定していればその値、なければ全スロット数
  const limit  = (dateSetting.limit !== null && dateSetting.limit !== undefined)
    ? dateSetting.limit : totalSlots;

  let occupiedSlots = 0;
  try {
    const _cachedA = getCachedBookings();
    let gasBookings = (_cachedA && _cachedA.length > 0) ? _cachedA : getRawBookings();
    const cancelled = getCancelledIds();
    const bookedForDate = [
      ...gasBookings.filter(b => b.date === date && !cancelled.has(b.reservationId)),
      ...getManualSheetBookings().filter(b => b.date === date)
    ];
    // ブロック済みスロットも「占有」として加算
    const blockedTimes = new Set(getBlockedSlotsList(date).map(b => b.time));
    const occupiedSet = new Set([...bookedForDate.map(b => b.time), ...blockedTimes]);
    occupiedSlots = occupiedSet.size;
  } catch(e) {
    Logger.log('予約カウントエラー: ' + e.message);
  }

  return {
    date, closed, limit, occupiedSlots,
    available: Math.max(0, limit - occupiedSlots),
    note: dateSetting.note || ''
  };
}

// =============================================================
// ── Web App POST エントリポイント ─────────────────────────────
// =============================================================
function doPost(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    let data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch(parseErr) {
      output.setContent(JSON.stringify({ success: false, error: 'Invalid request' }));
      return output;
    }

    // ── auth: 二段階認証（PIN → メールOTP → トークン発行）────────
    // キー不要（PINが秘密）
    if (data.action === 'auth') {

      // ── ステップ2: OTP検証 ──────────────────────────────────
      if (data.step === 'otp') {
        const result = verifyOtpCode(data.otp || '');
        if (result.valid) {
          clearPinAttempts();
          // 信頼済み端末は30日、通常は8時間有効のトークンを発行
          const token = generateAdminToken(data.rememberDevice === true, data.deviceId || null);
          output.setContent(JSON.stringify({ success: true, token: token }));
        } else {
          output.setContent(JSON.stringify({ success: false, error: result.error, expired: result.expired || false }));
        }
        return output;
      }

      // ── ステップ1: PIN検証 ──────────────────────────────────
      // ① ロック確認（PCI DSS v4.0: 10回失敗でロック）
      const lockState = getPinLockState();
      if (lockState.locked) {
        output.setContent(JSON.stringify({ success: false, error: 'ACCOUNT_LOCKED', lockedUntil: lockState.lockedUntil }));
        return output;
      }
      // ② PIN検証（管理者PIN → OTPステップ、スタッフPIN → 即トークン発行）
      const pin = data.pin || '';
      const staffPin = getStaffPin();

      if (pin && pin === getAdminPin()) {
        // 管理者PIN一致 → 従来通りOTPステップへ
        try {
          issueOtp();
          output.setContent(JSON.stringify({ success: true, step: 'otp' }));
        } catch(e) {
          output.setContent(JSON.stringify({ success: false, error: 'メール送信に失敗しました: ' + e.message }));
        }
        return output;
      }

      if (pin && staffPin && pin === staffPin) {
        // スタッフPIN一致 → OTP不要で即トークン発行
        clearPinAttempts(); // PIN成功なので失敗カウンタリセット
        const token = generateStaffToken();
        output.setContent(JSON.stringify({ success: true, token: token, role: 'staff' }));
        return output;
      }

      // どちらのPINとも不一致
      const result = recordPinFailure();
      if (result.locked) {
        output.setContent(JSON.stringify({ success: false, error: 'ACCOUNT_LOCKED', lockedUntil: result.lockedUntil }));
      } else {
        output.setContent(JSON.stringify({ success: false, error: 'PINが違います', attemptsLeft: result.attemptsLeft }));
      }
      return output;
    }

    // ── 公開エンドポイント（ACCESS_KEY認証、POST対応） ────────────
    // reserve.html / my-reservation.html がPOSTで呼び出す
    if (data.key && !isValidAccessKey(data.key)) {
      output.setContent(JSON.stringify({ success: false, error: 'Unauthorized' }));
      return output;
    }
    if (data.action === 'checkSlot' && data.key) {
      try {
        const date = data.date;
        if (!date) throw new Error('date required');
        output.setContent(JSON.stringify({ success: true, slots: getSlotAvailability(date), capacity: SLOT_CAPACITY }));
      } catch(err) {
        output.setContent(JSON.stringify({ success: false, error: err.message }));
      }
      return output;
    }
    if (data.action === 'getBookingForCustomer' && data.key) {
      try {
        const id    = data.id;
        const email = (data.email || '').toLowerCase().trim();
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
    if (data.action === 'submitRequest' && data.key) {
      try {
        const id      = data.id;
        const email   = (data.email || '').toLowerCase().trim();
        const type    = data.type;
        const newDate = data.newDate || '';
        const newTime = data.newTime || '';
        const message = data.message || '';
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

    // ── 予約OTP送信（顧客メール確認・二要素認証）──────────────────
    if (data.action === 'sendBookingOtp' && data.key) {
      try {
        const email = (data.email || '').toLowerCase().trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new Error('無効なメールアドレスです');
        }
        // OTP送信レート制限（同一メール: 3回/10分）
        const cache  = CacheService.getScriptCache();
        const rlKey  = 'botprl_' + email.replace(/[^a-z0-9]/g, '_').substring(0, 40);
        const rlCount = parseInt(cache.get(rlKey) || '0');
        if (rlCount >= 3) {
          output.setContent(JSON.stringify({ success: false, error: 'OTP_RATE_LIMIT' }));
          return output;
        }
        cache.put(rlKey, String(rlCount + 1), OTP_TTL_SEC);
        issueBookingOtp(email);
        output.setContent(JSON.stringify({ success: true }));
      } catch(err) {
        output.setContent(JSON.stringify({ success: false, error: err.message }));
      }
      return output;
    }

    // ── WEB予約の保存（公開フォームから、ACCESS_KEY で認証）──────
    if (data.action === 'save' && data.key) {
      if (!isValidAccessKey(data.key)) {
        output.setContent(JSON.stringify({ success: false, error: 'Unauthorized' }));
        return output;
      }
      const booking = data.booking;

      // ── サーバー側入力バリデーション ─────────────────────
      if (!booking || !booking.date || !booking.time || !booking.name || !booking.email) {
        output.setContent(JSON.stringify({ success: false, error: 'VALIDATION', message: '必須項目が不足しています' }));
        return output;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(booking.date)) {
        output.setContent(JSON.stringify({ success: false, error: 'VALIDATION', message: '日付形式が不正です' }));
        return output;
      }
      if (ALL_TIMES.indexOf(booking.time) === -1) {
        output.setContent(JSON.stringify({ success: false, error: 'VALIDATION', message: '時間が不正です' }));
        return output;
      }
      const bookingDate = new Date(booking.date + 'T00:00:00+09:00');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (bookingDate < today) {
        output.setContent(JSON.stringify({ success: false, error: 'VALIDATION', message: '過去の日付は指定できません' }));
        return output;
      }
      if (booking.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(booking.email)) {
        output.setContent(JSON.stringify({ success: false, error: 'VALIDATION', message: 'メールアドレスが不正です' }));
        return output;
      }

      // ── サーバーサイド入力サニタイズ ─────────────────────
      booking.name    = String(booking.name || '').trim().substring(0, 100);
      booking.remarks = String(booking.remarks || '').trim().substring(0, 500);
      booking.tel     = String(booking.tel || '').replace(/[^\d\-+()./ ]/g, '').substring(0, 30);

      // ── 定休日チェック（水曜日 + 設定日）──────────────────
      const bookingDow = new Date(booking.date + 'T00:00:00+09:00').getDay();
      if (bookingDow === 3) {
        output.setContent(JSON.stringify({ success: false, error: 'VALIDATION', message: '水曜日は定休日のため予約できません' }));
        return output;
      }
      const dateSettings = getAllSettings();
      if (dateSettings[booking.date] && dateSettings[booking.date].closed) {
        output.setContent(JSON.stringify({ success: false, error: 'VALIDATION', message: 'この日は休業日のため予約できません' }));
        return output;
      }

      // ── サーバーサイド金額検証 ─────────────────────────────
      const amountCheck = validateBookingTotal(booking);
      if (!amountCheck.valid) {
        Logger.log('金額検証失敗: ' + amountCheck.reason);
        notifyAdminError('AMOUNT_MISMATCH', amountCheck.reason, booking.email + ' / plan=' + booking.plan + ' / client=' + booking.total);
        output.setContent(JSON.stringify({ success: false, error: 'AMOUNT_MISMATCH', message: '金額の検証に失敗しました。ページを再読み込みしてやり直してください。' }));
        return output;
      }

      // ── カード決済の整合性チェック ─────────────────────────
      if (booking.paymentMethod === 'card') {
        if (!booking.total || booking.total <= 0) {
          output.setContent(JSON.stringify({ success: false, error: 'VALIDATION', message: '金額が0円の場合はカード決済できません' }));
          return output;
        }
        if (!data.cardToken) {
          output.setContent(JSON.stringify({ success: false, error: 'VALIDATION', message: 'カードトークンが不足しています' }));
          return output;
        }
      }

      if (booking.source === 'WEB') {
        // ── レート制限（同一メール: 5分間に3件まで）──────────
        const rlKey = 'rl_' + (booking.email || '').replace(/\W/g, '_');
        const rlCache = CacheService.getScriptCache();
        const rlCount = parseInt(rlCache.get(rlKey) || '0');
        if (rlCount >= 3) {
          output.setContent(JSON.stringify({ success: false, error: 'RATE_LIMIT', message: '送信回数の上限に達しました。5分後にお試しください。' }));
          return output;
        }
        rlCache.put(rlKey, String(rlCount + 1), 300); // 5分間

        // ── ロック取得（同時予約を防止）──────────────────────
        const lock = LockService.getScriptLock();
        try {
          lock.waitLock(15000);
        } catch(e) {
          output.setContent(JSON.stringify({ success: false, error: 'RETRY', message: '一時的に混雑しています。もう一度お試しください。' }));
          return output;
        }
        try {
          // ── OTP検証（ロック内で実行 → 再利用防止）──────────
          const otpResult = verifyBookingOtpCode(booking.email, data.otp || '');
          if (!otpResult.valid) {
            output.setContent(JSON.stringify({ success: false, error: otpResult.expired ? 'OTP_EXPIRED' : 'OTP_INVALID' }));
            return output;
          }

          // ── 冪等性チェック（同一IDの二重保存を防止）─────────
          if (booking.reservationId) {
            const existing = findBookingByIdFromSheet(booking.reservationId);
            if (existing) {
              output.setContent(JSON.stringify({ success: true, duplicate: true }));
              return output;
            }
          }

          // ── 空き確認（1時間帯1組：人数は問わない）────────────────
          const slots = getSlotAvailability(booking.date);
          const slot = slots[booking.time];
          if (slot && slot.remaining <= 0) {
            output.setContent(JSON.stringify({ success: false, error: 'SLOT_FULL', remaining: 0 }));
            return output;
          }

          // ── Pay.jp カード決済 ────────────────────────────────
          if (booking.paymentMethod === 'card' && data.cardToken && booking.total > 0) {
            try {
              const charge = createChargePayjp(
                data.cardToken,
                booking.total,
                'きものレンタル あかり / ' + booking.plan + ' / ' + booking.name
              );
              booking.chargeId      = charge.id;
              booking.paymentStatus = 'paid';
              Logger.log('Pay.jp 課金成功: ' + charge.id + ' ¥' + charge.amount);
            } catch(chargeErr) {
              // カード拒否はお客さん側の問題 → 管理者通知は不要（フォーム上でエラー表示済み）
              Logger.log('決済失敗（通知省略）: ' + chargeErr.message + ' / ' + booking.reservationId);
              output.setContent(JSON.stringify({ success: false, error: 'CHARGE_FAILED', message: chargeErr.message }));
              return output;
            }
          }

          // ── 保存（flush + 検証 + 決済ロールバック付き）──────
          saveManualToSheet(booking);
          SpreadsheetApp.flush();
          const savedCheck = findBookingByIdFromSheet(booking.reservationId || booking.id);
          if (!savedCheck) {
            Logger.log('CRITICAL: 保存失敗 id=' + booking.id);
            // 決済済みの場合は返金
            if (booking.chargeId) {
              Logger.log('保存失敗のため返金実行: ' + booking.chargeId);
              refundChargePayjp(booking.chargeId);
              notifyAdminError('SAVE_FAILED_REFUND', '保存失敗→自動返金', booking.id + ' / charge=' + booking.chargeId);
            }
            throw new Error('SAVE_FAILED');
          }

          // ── メール送信（失敗しても予約は有効）───────────────
          let emailOk = true;
          try {
            sendConfirmationEmail(booking);
          } catch(mailErr) {
            emailOk = false;
            Logger.log('確認メール送信失敗: ' + mailErr.message);
            notifyAdminError('sendConfirmationEmail', mailErr.message,
              booking.reservationId + ' / ' + booking.email);
          }
          try {
            sendAdminNotification(booking);
          } catch(adminMailErr) {
            Logger.log('管理者通知送信失敗: ' + adminMailErr.message);
          }

          output.setContent(JSON.stringify({
            success: true,
            reservationId: booking.reservationId,
            emailSent: emailOk
          }));
        } finally {
          lock.releaseLock();
        }
      } else {
        saveManualToSheet(booking);
        output.setContent(JSON.stringify({ success: true }));
      }
      return output;
    }

    // ── 以下はすべて管理者またはスタッフトークン認証が必要 ─────────
    const isAdmin = isValidAdminToken(data.token);
    const isStaff = !isAdmin && isValidStaffToken(data.token);
    if (!isAdmin && !isStaff) {
      output.setContent(JSON.stringify({ success: false, error: 'Unauthorized' }));
      return output;
    }

    // スタッフ禁止アクション（管理者のみ許可）
    const adminOnlyActions = [
      'saveManual', 'delete', 'getSettings', 'saveSettings', 'deleteSettings',
      'clearCache', 'blockSlot', 'unblockSlot',
      'getRequests', 'processRequest', 'updateBookingStatus'
    ];
    if (isStaff && adminOnlyActions.indexOf(data.action) !== -1) {
      output.setContent(JSON.stringify({ success: false, error: 'スタッフモードではこの操作はできません' }));
      return output;
    }

    // 全予約一覧取得
    if (data.action === 'getBookings') {
      // 月指定パラメータ（過去月の予約取得用）
      const reqYear  = data.year  ? parseInt(data.year)  : null;
      const reqMonth = data.month ? parseInt(data.month) : null;
      const todayDate = new Date();
      const todayCal = { y: todayDate.getFullYear(), m: todayDate.getMonth() + 1 };
      const isPastMonth = reqYear && reqMonth &&
        (reqYear < todayCal.y || (reqYear === todayCal.y && reqMonth < todayCal.m));

      let allBookings;

      if (isPastMonth) {
        // ── 過去月: スプレッドシートから月指定で取得（Gmail/キャッシュ不使用）──
        const externalBookings = getExternalSheetBookingsForMonth(reqYear, reqMonth);
        const manualBookings   = getManualSheetBookingsForMonth(reqYear, reqMonth);
        const cancelledIds     = getCancelledIds();
        const filtered         = externalBookings.filter(function(b) { return !cancelledIds.has(b.reservationId); });
        allBookings = [...filtered, ...manualBookings].sort(function(a, b) {
          if (a.date !== b.date) return a.date.localeCompare(b.date);
          return a.time.localeCompare(b.time);
        });
        Logger.log('過去月取得: ' + reqYear + '/' + reqMonth + ' → ' + allBookings.length + '件');
      } else {
        // ── 当月/未来月: 既存ロジック（Gmail + キャッシュ）──
        let bookings = getCachedBookings();
        if (!bookings || bookings.length === 0) {
          bookings = getRawBookings(); // ← 内部で syncExternalBookingsToSheet() が呼ばれ永続化
          Logger.log('キャッシュミス → Gmail再取得: ' + bookings.length + '件');
          setCachedBookings(bookings);
        } else {
          // キャッシュヒット時も外部予約シートから補完
          const externalSheet = getExternalSheetBookings();
          const cachedIds = new Set(bookings.map(function(b) { return b.reservationId; }));
          const recovered = externalSheet.filter(function(b) { return !cachedIds.has(b.reservationId); });
          if (recovered.length > 0) {
            bookings = [...bookings, ...recovered];
            Logger.log('キャッシュヒット: ' + (bookings.length - recovered.length) + '件 + 外部シート補完: ' + recovered.length + '件');
          } else {
            Logger.log('キャッシュヒット: ' + bookings.length + '件');
          }
        }
        const cancelledIds = getCancelledIds();
        const filtered = bookings.filter(function(b) { return !cancelledIds.has(b.reservationId); });
        const manualBookings = getManualSheetBookings(true);
        allBookings = [...filtered, ...manualBookings].sort(function(a, b) {
          if (a.date !== b.date) return a.date.localeCompare(b.date);
          return a.time.localeCompare(b.time);
        });
      } // ← isPastMonth else ブロックの終了

      // スタッフモード: 個人情報・金額をサーバー側で除去してから返す
      if (isStaff) {
        allBookings = allBookings.map(function(b) {
          const safe = Object.assign({}, b);
          delete safe.tel;
          delete safe.email;
          delete safe.remarks;
          delete safe.total;
          delete safe.payment;
          delete safe.pointUsed;
          delete safe.couponUsed;
          // オプションの金額情報を除去
          if (safe.options && Array.isArray(safe.options)) {
            safe.options = safe.options.map(function(o) {
              if (typeof o === 'object') {
                return { name: o.name };
              }
              return o;
            });
          }
          return safe;
        });
      }

      output.setContent(JSON.stringify({
        success: true, bookings: allBookings, count: allBookings.length,
        settings: isStaff ? {} : getAllSettings(), // スタッフには設定情報を返さない
        lastUpdated: new Date().toISOString(),
        role: isStaff ? 'staff' : 'admin'
      }));
      return output;
    }
    // 手動予約の保存（管理者）
    if (data.action === 'saveManual') {
      saveManualToSheet(data.booking);
      // 手動予約を即座にSupabaseに同期（ダブルブッキング防止）
      try { syncBookingsToSupabase(); } catch(e) { Logger.log('手動予約同期エラー: ' + e.message); }
      output.setContent(JSON.stringify({ success: true }));
      return output;
    }
    // 予約の非表示（削除）
    if (data.action === 'delete') {
      deleteManualFromSheet(data.id);
      output.setContent(JSON.stringify({ success: true }));
      return output;
    }
    // 日付設定の取得
    if (data.action === 'getSettings') {
      output.setContent(JSON.stringify({ success: true, settings: getAllSettings() }));
      return output;
    }
    // 日付設定の保存
    if (data.action === 'saveSettings') {
      const limit = (data.limit !== '' && data.limit !== undefined && data.limit !== null) ? parseInt(data.limit) : null;
      const photoLimit = (data.photoLimit !== '' && data.photoLimit !== undefined && data.photoLimit !== null) ? parseInt(data.photoLimit) : null;
      const photoBlockedSlots = Array.isArray(data.photoBlockedSlots) ? data.photoBlockedSlots.join(',') : (data.photoBlockedSlots || '');
      const blockedSlots = Array.isArray(data.blockedSlots) ? data.blockedSlots.join(',') : (data.blockedSlots || '');
      Logger.log('saveSettings: date=' + data.date + ' limit=' + limit + ' closed=' + data.closed + ' photoLimit=' + photoLimit);
      saveSettingsToSheet(data.date, limit, data.closed === true || data.closed === 'true', data.note || '', photoLimit, photoBlockedSlots, blockedSlots);
      // 保存後に読み返して確認
      const verify = getAllSettings();
      Logger.log('saveSettings verify: ' + JSON.stringify(verify[data.date]));
      output.setContent(JSON.stringify({ success: true }));
      return output;
    }
    // 日付設定の削除
    if (data.action === 'deleteSettings') {
      deleteSettingsFromSheet(data.date);
      output.setContent(JSON.stringify({ success: true }));
      return output;
    }
    // キャッシュ強制クリア
    if (data.action === 'clearCache') {
      clearCache();
      const fresh = getRawBookings(); // ← 内部で syncExternalBookingsToSheet() が呼ばれ永続化
      setCachedBookings(fresh);
      logAudit('MANUAL_CACHE_CLEAR', { count: fresh.length, message: '管理者による手動キャッシュクリア' });
      output.setContent(JSON.stringify({ success: true, refreshed: fresh.length }));
      return output;
    }
    // ブロック済みスロット一覧取得
    if (data.action === 'getBlockedSlots') {
      if (!data.date) throw new Error('date が必要です');
      output.setContent(JSON.stringify({ success: true, blocked: getBlockedSlotsList(data.date) }));
      return output;
    }
    // スロットブロック
    if (data.action === 'blockSlot') {
      if (!data.date || !data.time) throw new Error('date と time が必要です');
      blockSlotInSheet(data.date, data.time, data.reason || '管理者ブロック');
      output.setContent(JSON.stringify({ success: true }));
      return output;
    }
    // スロットブロック解除
    if (data.action === 'unblockSlot') {
      if (!data.date || !data.time) throw new Error('date と time が必要です');
      unblockSlotInSheet(data.date, data.time);
      output.setContent(JSON.stringify({ success: true }));
      return output;
    }
    // 申請一覧取得
    if (data.action === 'getRequests') {
      const statusFilter = data.status || 'pending';
      output.setContent(JSON.stringify({ success: true, requests: getRequestsList(statusFilter) }));
      return output;
    }
    // 申請を承認・却下
    if (data.action === 'processRequest') {
      if (!data.requestId || !data.decision) throw new Error('パラメータが不足しています');
      processRequestById(data.requestId, data.decision, data.adminNote || '');
      output.setContent(JSON.stringify({ success: true }));
      return output;
    }

    // ステータス更新（来店済み / 有料キャンセル / 無料キャンセル）
    if (data.action === 'updateBookingStatus') {
      if (!data.bookingId || !data.newStatus) throw new Error('bookingId と newStatus が必要です');
      const allowed = ['visited', 'paid-cancel', 'free-cancel'];
      if (allowed.indexOf(data.newStatus) === -1) throw new Error('無効なステータス: ' + data.newStatus);
      const result = processBookingStatusUpdate(data.bookingId, data.newStatus);
      output.setContent(JSON.stringify({ success: true, ...result }));
      return output;
    }

    output.setContent(JSON.stringify({ success: false, error: 'Unknown action' }));
  } catch(err) {
    notifyAdminError('doPost', err.message, JSON.stringify(data || {}).substring(0, 300));
    output.setContent(JSON.stringify({ success: false, error: err.message }));
  }
  return output;
}

// =============================================================
// ── 監視・エラー通知 ────────────────────────────────────────────
// =============================================================
// ── Pay.jp 課金処理 ──────────────────────────────────────────
// =============================================================
function getPayjpSecretKey() {
  return PropertiesService.getScriptProperties().getProperty('PAYJP_SECRET_KEY') || '';
}

/**
 * Pay.jp でカード課金を実行
 * @param {string} cardToken  - payjp.js で生成したトークン (tok_xxx)
 * @param {number} amount     - 課金金額（円、最低50円）
 * @param {string} desc       - 説明文（管理画面に表示）
 * @returns {object} Pay.jp charge オブジェクト
 */
function createChargePayjp(cardToken, amount, desc) {
  const secretKey = getPayjpSecretKey();
  if (!secretKey) throw new Error('PAYJP_SECRET_KEY が設定されていません。Script Properties を確認してください。');
  const resp = UrlFetchApp.fetch('https://api.pay.jp/v1/charges', {
    method: 'post',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(secretKey + ':')
    },
    payload: {
      amount:      String(amount),
      currency:    'jpy',
      card:        cardToken,
      description: desc,
      capture:     'true'
    },
    muteHttpExceptions: true
  });
  const result = JSON.parse(resp.getContentText());
  if (result.error) {
    Logger.log('Pay.jp charge error: ' + JSON.stringify(result.error));
    throw new Error(result.error.message || '決済処理中にエラーが発生しました');
  }
  return result;
}

/**
 * Pay.jp の課金を返金（保存失敗時のロールバック用）
 * @param {string} chargeId - Pay.jp charge ID (ch_xxx)
 */
function refundChargePayjp(chargeId) {
  const secretKey = getPayjpSecretKey();
  if (!secretKey || !chargeId) return;
  try {
    const resp = UrlFetchApp.fetch('https://api.pay.jp/v1/charges/' + chargeId + '/refund', {
      method: 'post',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(secretKey + ':') },
      muteHttpExceptions: true
    });
    const result = JSON.parse(resp.getContentText());
    if (result.error) {
      Logger.log('Pay.jp refund error: ' + JSON.stringify(result.error));
    } else {
      Logger.log('Pay.jp refund OK: ' + chargeId);
    }
  } catch(e) {
    Logger.log('Pay.jp refund exception: ' + e.message);
    notifyAdminError('REFUND_FAILED', e.message, chargeId);
  }
}

// =============================================================
// ── 来店ステータス更新処理 ──────────────────────────────────────
// =============================================================

/**
 * 予約ステータスを更新（手動予約シート）
 * @param {string} bookingId - 予約ID
 * @param {string} newStatus - visited | paid-cancel | free-cancel
 * @returns {{ status, charged, chargeId, refunded }}
 */
function processBookingStatusUpdate(bookingId, newStatus) {
  const sheet = getManualSheet();
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(bookingId)) {
      rowIndex = i;
      break;
    }
  }
  if (rowIndex === -1) throw new Error('予約が見つかりません: ' + bookingId);

  const row = data[rowIndex];
  const payment = String(row[9]);
  const existingChargeId = String(row[15] || '');
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  const total = parseInt(row[8]) || 0;
  const bookingName = String(row[3]);
  const bookingEmail = String(row[11]);
  const bookingDate = row[1] instanceof Date ? Utilities.formatDate(row[1], 'Asia/Tokyo', 'yyyy-MM-dd') : String(row[1]);
  const bookingTime = row[2] instanceof Date ? Utilities.formatDate(row[2], 'Asia/Tokyo', 'HH:mm') : String(row[2]);
  const bookingPlan = String(row[4]);
  const bookingPeople = String(row[6]);

  let charged = false;
  let newChargeId = existingChargeId;
  let refunded = false;

  // 来店済み → カード払い客のみ決済不要（予約時に決済済み）
  // 有料キャンセル → カード払い客はすでに決済済みなので追加決済不要
  // 無料キャンセル → カード払い客は返金

  if (newStatus === 'free-cancel' && payment === 'card' && existingChargeId) {
    // 無料キャンセル + カード決済済み → 返金
    try {
      refundChargePayjp(existingChargeId);
      refunded = true;
      Logger.log('無料キャンセル返金: ' + existingChargeId);
    } catch(e) {
      Logger.log('返金エラー: ' + e.message);
      notifyAdminError('FREE_CANCEL_REFUND', e.message, bookingId + ' / charge=' + existingChargeId);
    }
  }

  // シート更新: visitStatus (col 15), visitChargeId (col 16), statusUpdatedAt (col 17)
  sheet.getRange(rowIndex + 1, 15).setValue(newStatus);
  sheet.getRange(rowIndex + 1, 16).setValue(newChargeId);
  sheet.getRange(rowIndex + 1, 17).setValue(now);

  // 監査ログ
  logAudit('STATUS_UPDATE', {
    bookingId: bookingId,
    newStatus: newStatus,
    payment: payment,
    charged: charged,
    refunded: refunded
  });

  // 来店済みの場合、感謝メール送信
  if (newStatus === 'visited' && bookingEmail) {
    try {
      sendThankYouEmail({
        name: bookingName,
        email: bookingEmail,
        date: bookingDate,
        time: bookingTime,
        plan: bookingPlan,
        people: bookingPeople
      });
    } catch(e) {
      Logger.log('感謝メール送信エラー: ' + e.message);
      notifyAdminError('THANK_YOU_EMAIL', e.message, bookingId);
    }
  }

  return { status: newStatus, charged, chargeId: newChargeId, refunded };
}

// 同一コンテキストのエラーは1時間に1回だけ管理者にメール送信
// =============================================================
function notifyAdminError(context, message, details) {
  const cacheKey = 'err_' + context.replace(/\W/g, '_');
  const cache = CacheService.getScriptCache();
  if (cache.get(cacheKey)) return; // クールダウン中はスキップ
  cache.put(cacheKey, '1', 3600);  // 1時間クールダウン
  try {
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const subject = `【システムエラー】きものレンタル あかり — ${context}`;
    const body = `GASスクリプトでエラーが発生しました。

発生日時 : ${now}
発生箇所 : ${context}
エラー   : ${message}${details ? '\n詳細     : ' + details : ''}

GASエディタの実行ログで詳細を確認してください。
https://script.google.com/home`;
    GmailApp.sendEmail(getAdminEmail(), subject, body);
    Logger.log('エラー通知送信: ' + context + ' — ' + message);
  } catch(e) {
    Logger.log('エラー通知送信失敗: ' + e.message);
  }
}

// =============================================================
// ── キャッシュ管理 ─────────────────────────────────────────────
// =============================================================
function getCachedBookings() {
  try { const c = CacheService.getScriptCache().get('bookings_v2'); return c ? JSON.parse(c) : null; }
  catch(e) { return null; }
}
function setCachedBookings(b) {
  // 空配列はキャッシュしない（GMail API一時エラー時に空が永続化するのを防ぐ）
  if (!b || b.length === 0) return;
  try {
    const s = JSON.stringify(b);
    if (s.length < 90000) {
      CacheService.getScriptCache().put('bookings_v2', s, 1800); // 30分TTL（旧：1時間）
    } else {
      Logger.log('キャッシュサイズ超過: ' + s.length + ' bytes — キャッシュをスキップ');
      notifyAdminError('setCachedBookings', 'キャッシュサイズ超過: ' + s.length + ' bytes（上限90KB）— 予約件数が増えすぎている可能性があります');
    }
  } catch(e) {}
}
function clearCache() { CacheService.getScriptCache().remove('bookings_v2'); Logger.log('キャッシュクリア'); }

// =============================================================
// ── 自動同期トリガー ──────────────────────────────────────────
// setupDailyTrigger()  → 毎朝8時にフル同期
// setupHourlyTrigger() → 1時間ごとにキャッシュ更新（営業時間帯のキャッシュ鮮度確保）
// =============================================================
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'dailySync') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailySync').timeBased().everyDays(1).atHour(8).inTimezone('Asia/Tokyo').create();
  Logger.log('毎朝8時（JST）のトリガーを設定しました');
}
function dailySync() {
  try {
    clearCache();
    const b = getAllBookings(); // ← getRawBookings() 内で syncExternalBookingsToSheet() が呼ばれ永続化
    setCachedBookings(b);
    // dailySync でのGmail同期タイムスタンプを更新（直後のhourlySync でGmailを2重呼び出ししない）
    PropertiesService.getScriptProperties().setProperty('last_gmail_sync_ts', String(new Date().getTime()));
    logAudit('DAILY_SYNC', { count: b.length, message: '毎朝同期完了' });
    Logger.log('同期完了: ' + b.length + '件');
    // 毎朝バックアップも実行
    backupBookings();
  } catch(e) {
    Logger.log('同期エラー: ' + e.message);
    logAudit('DAILY_SYNC_ERROR', { error: e.message });
    notifyAdminError('dailySync', e.message);
  }
}

function setupHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'hourlySync') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('hourlySync').timeBased().everyHours(1).create();
  Logger.log('1時間ごとのキャッシュ更新トリガーを設定しました');
}
function hourlySync() {
  try {
    clearCache();
    // ── Gmail クォータ節約 ─────────────────────────────────────
    // 外部予約シートに2時間以内のGmail同期データがあればGmailを呼ばない
    // → 1日24回→最大12回のGmail呼び出しに削減
    const props = PropertiesService.getScriptProperties();
    const lastSyncTs = props.getProperty('last_gmail_sync_ts');
    const now = new Date().getTime();
    const twoHours = 2 * 60 * 60 * 1000;
    let b;
    if (lastSyncTs && (now - parseInt(lastSyncTs)) < twoHours) {
      // Gmailスキップ: 外部予約シートからキャッシュ再構築
      const sheetBookings = getExternalSheetBookings();
      const cancelledIds  = getCancelledIds();
      b = sheetBookings.filter(bk => !cancelledIds.has(bk.reservationId));
      const elapsed = Math.round((now - parseInt(lastSyncTs)) / 60000);
      Logger.log('hourlySync: Gmailスキップ（前回Gmail同期から' + elapsed + '分）, シートから' + b.length + '件');
      logAudit('HOURLY_SYNC_SHEET_ONLY', { count: b.length, minutesSinceGmail: elapsed });
    } else {
      // Gmail呼び出し + シート永続化
      b = getRawBookings();
      props.setProperty('last_gmail_sync_ts', String(now));
      logAudit('HOURLY_SYNC', { count: b.length, message: 'Gmail同期完了' });
      Logger.log('キャッシュ更新完了(Gmail): ' + b.length + '件');
    }
    setCachedBookings(b);
    // GAS側の予約をSupabaseに同期（ダブルブッキング防止）
    syncBookingsToSupabase();
  } catch(e) {
    Logger.log('キャッシュ更新エラー: ' + e.message);
    logAudit('HOURLY_SYNC_ERROR', { error: e.message });
    notifyAdminError('hourlySync', e.message);
  }
}

// =============================================================
// ── GAS → Supabase 予約同期 ─────────────────────────────────────
// Supabaseのbookingsテーブルに、GAS側の予約データを一方向同期する。
// 目的: 管理画面の手動予約やAJ/じゃらん予約を、reserve.htmlの
//       check-slotに反映してダブルブッキングを防止する。
// =============================================================

/**
 * GASの全予約をSupabaseにUPSERT同期する
 * 手動予約 + 外部予約（AJ/じゃらん）を対象。
 * WEB予約はSupabaseに直接保存されるため、ここでは上書きしない。
 */
function syncBookingsToSupabase() {
  const props = PropertiesService.getScriptProperties();
  const supabaseUrl = props.getProperty('SUPABASE_URL');
  const supabaseKey = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseKey) {
    Logger.log('Supabase同期スキップ: SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定');
    return;
  }

  try {
    // 手動予約 + 外部予約を取得（今日以降のみ）
    const manual = getManualSheetBookings();
    const external = getExternalSheetBookings();

    // GAS側の全予約を同期（移行前のWEB予約もGASにしかないため）
    // UPSERTなので、Supabaseに既にある予約は上書き更新される
    const gasBookings = [...manual, ...external];

    if (gasBookings.length === 0) {
      Logger.log('Supabase同期: 対象予約なし');
      return;
    }

    // Supabase bookingsテーブルの形式に変換
    var records = gasBookings.map(function(b) {
      return {
        id: b.id || b.reservationId,
        reservation_id: b.reservationId || b.id,
        source: b.source || 'MANUAL',
        date: b.date,
        time: b.time,
        name: b.name,
        email: b.email || null,
        tel: b.tel || null,
        plan: b.plan || 'ベーシック',
        people: b.people || null,
        options: b.options || [],
        total: b.total || 0,
        payment: b.payment || null,
        remarks: b.remarks || null,
        charge_id: b.visitChargeId || null,
        payment_status: b.visitChargeId ? 'paid' : 'pending',
        visit_status: b.visitStatus || 'confirmed',
        channel: b.channel || null,
        created_at: b.createdAt || new Date().toISOString()
      };
    });

    // Supabase REST APIで一括UPSERT（50件ずつバッチ処理）
    var batchSize = 50;
    var totalUpserted = 0;
    for (var i = 0; i < records.length; i += batchSize) {
      var batch = records.slice(i, i + batchSize);
      var resp = UrlFetchApp.fetch(supabaseUrl + '/rest/v1/bookings', {
        method: 'post',
        headers: {
          'Authorization': 'Bearer ' + supabaseKey,
          'apikey': supabaseKey,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        payload: JSON.stringify(batch),
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      if (code >= 400) {
        Logger.log('Supabase UPSERT エラー (' + code + '): ' + resp.getContentText().substring(0, 200));
      } else {
        totalUpserted += batch.length;
      }
    }
    Logger.log('Supabase同期完了: ' + totalUpserted + '/' + records.length + '件');
  } catch(e) {
    Logger.log('Supabase同期エラー: ' + e.message);
  }
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

    GmailApp.sendEmail(booking.email, subject, body, { from: CUSTOMER_EMAIL_FROM, name: '着物レンタル あかり' });
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
// ── 来店感謝メール + Google口コミ誘導 ─────────────────────────
// =============================================================
function sendThankYouEmail(booking) {
  if (!booking.email) return;
  try {
    const reviewUrl = PropertiesService.getScriptProperties().getProperty('GOOGLE_REVIEW_URL') || '';
    const dateStr = formatBookingDate(booking.date);
    const subject = '【きものレンタル あかり】ご来店ありがとうございました';
    const body = `${booking.name} 様

この度はきものレンタル あかりにご来店いただき、誠にありがとうございました。

━━━━━━━━━━━━━━━━━━━━━━━━━━
　ご利用内容
━━━━━━━━━━━━━━━━━━━━━━━━━━
来店日時　：${dateStr} ${booking.time}
プラン　　：${booking.plan}
人数　　　：${booking.people}
━━━━━━━━━━━━━━━━━━━━━━━━━━

金沢での着物体験はいかがでしたでしょうか？
お客様のお声が、私たちの励みになります。${reviewUrl ? `

よろしければ、Googleでの口コミをお願いいたします：
${reviewUrl}` : ''}

またのお越しを心よりお待ちしております。

──────────────────────────────
きものレンタル あかり
TEL：076-201-8119
定休日：水曜日
※ このメールは自動送信です。ご返信はお受けできません。`;

    GmailApp.sendEmail(booking.email, subject, body, { from: CUSTOMER_EMAIL_FROM, name: '着物レンタル あかり' });
    Logger.log('感謝メール送信: ' + booking.email);
  } catch(e) {
    Logger.log('感謝メール送信エラー: ' + e.message);
    throw e;
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
  const cached    = getCachedBookings() || [];
  const manual    = getManualSheetBookings();
  const external  = getExternalSheetBookings();
  const cancelled = getCancelledIds();
  // キャッシュ + 外部予約シート を重複排除してマージ
  const externalIds = new Set(cached.map(b => b.reservationId));
  const recoveredExternal = external.filter(b => !externalIds.has(b.reservationId));
  const allForDate = [...cached, ...recoveredExternal, ...manual].filter(b =>
    b.date === date && !cancelled.has(b.reservationId)
  );
  // ブロック済み時間帯を取得
  const blockedList  = getBlockedSlotsList(date);
  const blockedTimes = new Set(blockedList.map(b => b.time));
  const blockedReasons = {};
  blockedList.forEach(b => { blockedReasons[b.time] = b.reason; });

  // 撮影プラン設定を取得
  const settings = getAllSettings();
  const dateSetting = settings[date] || {};
  const defaultSetting = settings['DEFAULT'] || {};
  const photoLimit = dateSetting.photoLimit !== null && dateSetting.photoLimit !== undefined
    ? dateSetting.photoLimit
    : (defaultSetting.photoLimit !== null && defaultSetting.photoLimit !== undefined ? defaultSetting.photoLimit : 2);
  const photoBlockedSlots = new Set(dateSetting.photoBlockedSlots || []);
  const settingsBlockedSlots = new Set(dateSetting.blockedSlots || []); // 設定モーダルからの一般ブロック

  // 撮影プラン予約数をカウント（プラン名に「撮影」を含む予約）
  const photoBookingsForDate = allForDate.filter(function(b) {
    return b.plan && b.plan.indexOf('撮影') >= 0;
  });
  const totalPhotoBooked = photoBookingsForDate.length;

  const result = {};
  ALL_TIMES.forEach(t => {
    const booked  = allForDate.filter(b => b.time === t).length;
    const blocked = blockedTimes.has(t) || settingsBlockedSlots.has(t); // スロットブロック OR 設定ブロック
    const photoBlocked = photoBlockedSlots.has(t);
    const photoBookedInSlot = photoBookingsForDate.filter(b => b.time === t).length;
    result[t] = {
      booked,
      blocked,
      reason: blockedReasons[t] || '',
      remaining: (blocked || booked >= SLOT_CAPACITY) ? 0 : SLOT_CAPACITY - booked,
      // 撮影プラン情報
      photoBlocked: photoBlocked,
      photoRemaining: (photoBlocked || totalPhotoBooked >= photoLimit) ? 0 : photoLimit - totalPhotoBooked
    };
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
    GmailApp.sendEmail(booking.email, subject, body, { from: CUSTOMER_EMAIL_FROM, name: '着物レンタル あかり' });
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

// =============================================================
// ── 初回マイグレーション ───────────────────────────────────────
// GASエディタで1回だけ実行: 既存のGmail予約を外部予約シートに保存
// =============================================================
function migrateExternalBookings() {
  Logger.log('=== 外部予約マイグレーション開始 ===');
  const jaran = getJaranBookings();
  const aj    = getActivityJapanBookings();
  const all   = [...jaran, ...aj];
  Logger.log('Gmail解析: じゃらん=' + jaran.length + ', AJ=' + aj.length + ', 合計=' + all.length);

  const result = syncExternalBookingsToSheet(all);
  logAudit('MIGRATION', {
    jaran: jaran.length, aj: aj.length,
    added: result.added, updated: result.updated
  });
  Logger.log('マイグレーション完了: 追加=' + result.added + ', 更新=' + result.updated);
}

// =============================================================
// ── 予約データバックアップ ─────────────────────────────────────
// 全予約のスナップショットをバックアップシートに保存
// dailySyncから自動実行 or 手動実行
// =============================================================
function backupBookings() {
  try {
    const ss = getManualSheet().getParent();
    let sheet = ss.getSheetByName('バックアップ');
    if (!sheet) {
      sheet = ss.insertSheet('バックアップ');
      sheet.appendRow(['snapshotAt', 'type', 'count', 'data']);
      Logger.log('バックアップシートを作成しました');
    }

    const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

    // 外部予約のバックアップ
    const external = getExternalSheetBookings();
    if (external.length > 0) {
      const extJson = JSON.stringify(external);
      if (extJson.length < 45000) {
        sheet.appendRow([now, '外部予約', external.length, extJson]);
      } else {
        sheet.appendRow([now, '外部予約', external.length, '(データサイズ超過: ' + extJson.length + 'bytes)']);
      }
    }

    // 手動予約のバックアップ
    const manual = getManualSheetBookings();
    if (manual.length > 0) {
      const manJson = JSON.stringify(manual);
      if (manJson.length < 45000) {
        sheet.appendRow([now, '手動予約', manual.length, manJson]);
      } else {
        sheet.appendRow([now, '手動予約', manual.length, '(データサイズ超過: ' + manJson.length + 'bytes)']);
      }
    }

    // 古い行（30日以上前）を削除
    const data = sheet.getDataRange().getValues();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = Utilities.formatDate(cutoff, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) < cutoffStr) {
        sheet.deleteRow(i + 1);
      }
    }

    logAudit('BACKUP', { external: external.length, manual: manual.length });
    Logger.log('バックアップ完了: 外部=' + external.length + ', 手動=' + manual.length);
  } catch(e) {
    Logger.log('バックアップエラー: ' + e.message);
    logAudit('BACKUP_ERROR', { error: e.message });
  }
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

// AJ変更メールのデバッグ関数
function debugAJChange() {
  const threads = GmailApp.search(
    '(from:activity-japan@activityjapan.com OR from:reserve-system@activityjapan.com)', 0, 50
  );
  Logger.log('検索ヒット: ' + threads.length + 'スレッド');
  let changeCount = 0;
  let parseOk = 0;
  let parseFail = 0;
  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const subj = msg.getSubject();
      if (!subj.includes('変更')) continue;
      changeCount++;
      const body = msg.getPlainBody();
      const result = parseAJChangeEmail(body);
      if (result) {
        parseOk++;
        Logger.log('✓ 解析OK: #' + result.reservationId + ' → ' + result.date + ' ' + result.time);
      } else {
        parseFail++;
        Logger.log('✗ 解析失敗: 件名=[' + subj + '] 送信元=[' + msg.getFrom() + ']');
        Logger.log('  本文先頭500文字: ' + body.substring(0, 500));
      }
    }
  }
  Logger.log('変更メール合計: ' + changeCount + '件 / 解析OK: ' + parseOk + ' / 失敗: ' + parseFail);
}

// =============================================================
// ── 健全性監視（Health Check / Synthetic Monitoring）─────────────
// =============================================================
// 2026-04-17 追加。4/5のACCESS_KEYローテーションでXserver旧版の予約が
// 12日間静かに壊れていた事故の再発防止。詳細は project memory 参照。
// セットアップ: GASエディタで setupHealthCheckTriggers() を1回手動実行。

const HEALTH_CHECK_DEPLOY_URL = 'https://script.google.com/macros/s/AKfycbyUjRWMu_ZgGroCakrRfIxuobAjJvl_So1HVzK2s5wEYY-ToZUjo89jwRgy5GQwb6Si/exec';
const XSERVER_RESERVE_URL     = 'https://akari-kanazawa.jp/reserve/reserve.html';

/**
 * 毎日実行: GASのcheckSlot APIをお客様視点で実際に叩いて、正常応答するか確認。
 * Unauthorized・接続エラー・JSONパース失敗のいずれもアラート対象。
 * ACCESS_KEYミスマッチ・デプロイ事故・GAS停止などを「予約が止まる前」に検知できる。
 * 予約数とは無関係なので閑散期でも誤報ゼロ。
 */
function dailyHealthCheck() {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const key   = getAccessKey();
  const url   = HEALTH_CHECK_DEPLOY_URL + '?key=' + encodeURIComponent(key) + '&action=checkSlot&date=' + today;

  try {
    const res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const code = res.getResponseCode();
    const body = res.getContentText();

    if (code !== 200) {
      sendHealthAlert('GAS API不調 (HTTP ' + code + ')',
        'checkSlot APIがHTTP ' + code + 'を返しました。\n\nレスポンス先頭500字:\n' + body.substring(0, 500));
      return;
    }

    const data = JSON.parse(body);
    if (!data.success) {
      sendHealthAlert('GAS API認証/動作エラー',
        'checkSlot APIが success=false を返しました。\n\n' +
        'エラー: ' + (data.error || '(不明)') + '\n\n' +
        '考えられる原因:\n' +
        '  - ACCESS_KEYの不一致（rotation後の更新漏れ等）\n' +
        '  - デプロイ事故\n' +
        '  - GAS Script Property破損\n\n' +
        '至急確認してください。');
      return;
    }

    Logger.log('Health check OK: ' + JSON.stringify(data).substring(0, 200));
  } catch (err) {
    sendHealthAlert('Health Check例外',
      'dailyHealthCheck()で例外: ' + err.message + '\n\n' +
      'GASがネットワーク的に到達不可、もしくはJSON解析に失敗しています。');
  }
}

/**
 * 毎週月曜実行: Xserverのリダイレクトが生きているか確認。
 * 200が返ったら=リダイレクトが消えているのでアラート。
 * 畠中さんのリダイレクト反映後に意味を持つ（反映前は常にアラート出る）。
 */
function weeklyXserverRedirectCheck() {
  try {
    const res  = UrlFetchApp.fetch(XSERVER_RESERVE_URL, {
      muteHttpExceptions: true,
      followRedirects:    false
    });
    const code = res.getResponseCode();

    if (code === 301 || code === 302) {
      Logger.log('Xserver redirect OK (HTTP ' + code + ')');
      return;
    }
    if (code === 200) {
      sendHealthAlert('Xserverリダイレクト消失',
        XSERVER_RESERVE_URL + ' がHTTP 200を返しています（301/302が期待値）。\n\n' +
        'リダイレクト設定が外された可能性があります。畠中さんに確認してください。\n\n' +
        '現状で予約自体は動いていますが、未来のACCESS_KEYローテーションで再発リスクがあります。');
    } else {
      sendHealthAlert('Xserver応答異常',
        XSERVER_RESERVE_URL + ' がHTTP ' + code + ' を返しています。');
    }
  } catch (err) {
    sendHealthAlert('Xserverチェック例外', 'weeklyXserverRedirectCheck()例外: ' + err.message);
  }
}

/**
 * 毎週月曜実行: ヒロシに週次サマリーをメール送付（情報提供のみ・アラートではない）。
 * 過去7日のWEB予約数・過去30日の平均を可視化。
 */
function weeklyBookingSummary() {
  try {
    const cached   = getCachedBookings();
    const all      = (cached && cached.length > 0) ? cached : getRawBookings();
    const cancelled = getCancelledIds();

    const now      = new Date();
    const tz       = 'Asia/Tokyo';
    const today    = new Date(Utilities.formatDate(now, tz, 'yyyy/MM/dd'));
    const past7    = new Date(today.getTime() - 7  * 86400000);
    const past30   = new Date(today.getTime() - 30 * 86400000);

    // WEB予約判定（HP-で始まる予約番号、キャンセル除く）
    const isWebBooking = b => {
      if (cancelled.has(b.reservationId)) return false;
      const id = b.reservationId || '';
      return id.indexOf('HP-') === 0;
    };

    // 受付日時の取得（複数フィールド名に対応）
    const parseCreated = b => {
      const v = b.createdAt || b.created_at || b.timestamp;
      if (!v) return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    };

    const web7  = all.filter(b => { if (!isWebBooking(b)) return false; const d = parseCreated(b); return d && d >= past7;  }).length;
    const web30 = all.filter(b => { if (!isWebBooking(b)) return false; const d = parseCreated(b); return d && d >= past30; }).length;
    const avgDaily30 = (web30 / 30).toFixed(1);

    const subject = '[週次レポート] 予約システム状況 ' + Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    const body = [
      '着物レンタル予約システム 週次サマリー',
      '',
      '■ WEB予約件数',
      '  過去7日:  ' + web7  + '件',
      '  過去30日: ' + web30 + '件 (1日平均 ' + avgDaily30 + '件)',
      '',
      '■ 状態確認',
      '  - 過去7日が著しく少ない場合、システム不具合の可能性あり',
      '  - 閑散期の自然な減少か判断に迷う場合は、GA4で reserve.html の流入を確認',
      '  - https://analytics.google.com/  →  着物レンタル予約 プロパティ',
      '',
      '※ このメールは情報提供です。アラートではありません。'
    ].join('\n');

    GmailApp.sendEmail(getAdminEmail(), subject, body);
  } catch (err) {
    sendHealthAlert('週次サマリー生成エラー', 'weeklyBookingSummary()例外: ' + err.message);
  }
}

/**
 * アラートメール送信ヘルパー
 */
function sendHealthAlert(subject, body) {
  const fullBody = body + '\n\n――――――\n発生時刻: ' + new Date().toISOString() + '\nプロジェクト: 着物レンタル予約システム';
  GmailApp.sendEmail(getAdminEmail(), '[ALERT] 予約システム: ' + subject, fullBody);
}

/**
 * セットアップ用: 健全性チェックTriggerを再構築。
 * GASエディタで「setupHealthCheckTriggers」を選んで実行ボタンを1回押すだけ。
 * 既に登録されている同名Triggerは削除して登録し直す（重複防止）。
 */
function setupHealthCheckTriggers() {
  const targets = ['dailyHealthCheck', 'weeklyXserverRedirectCheck', 'weeklyBookingSummary'];

  // 既存削除
  ScriptApp.getProjectTriggers().forEach(t => {
    if (targets.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 毎日12時
  ScriptApp.newTrigger('dailyHealthCheck')
    .timeBased().atHour(12).everyDays(1).create();

  // 毎週月曜10時
  ScriptApp.newTrigger('weeklyXserverRedirectCheck')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(10).create();
  ScriptApp.newTrigger('weeklyBookingSummary')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(10).create();

  Logger.log('健全性チェックTriggerを登録しました（dailyHealthCheck / weeklyXserverRedirectCheck / weeklyBookingSummary）');
}
