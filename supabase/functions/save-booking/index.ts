// save-booking: 予約保存（OTP検証→金額検証→決済→DB保存→メール通知）
// GASの doPost save セクション (lines 1821-1998) を移植
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { handleCors } from '../_shared/cors.ts';
import { getSupabaseClient } from '../_shared/supabase.ts';
import { successResponse, errorResponse } from '../_shared/response.ts';

// GASと同じ定数
const ALL_TIMES = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
  '12:00', '12:30', '13:00', '13:30', '14:00',
];
const SLOT_CAPACITY = 1;
const OTP_MAX_FAIL = 5;
const BOOKING_RATE_LIMIT = 3;       // 5分間に3件まで
const BOOKING_RATE_WINDOW_SEC = 300; // 5分

// サイトベースURL（予約確認リンク用）
const SITE_BASE_URL = Deno.env.get('SITE_BASE_URL') || 'https://yossi-akari.github.io/kimono-calendar';
const ADMIN_EMAIL = Deno.env.get('ADMIN_EMAIL') || 'rentalakari@gmail.com';

// =============================================
// ヘルパー関数
// =============================================

// メール形式チェック
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// 日付フォーマット: "2026-03-15" → "2026年3月15日（日）"
function formatBookingDate(dateStr: string): string {
  const DAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${DAY_JA[d.getDay()]}）`;
}

// オプション文字列化
function formatOptions(options: Array<{ name: string }> | null): string {
  if (!options || options.length === 0) return 'なし';
  return options.map((o) => (typeof o === 'string' ? o : o.name)).join('、');
}

// =============================================
// OTP検証（GASの verifyBookingOtpCode を移植）
// =============================================
async function verifyOtp(
  sb: ReturnType<typeof getSupabaseClient>,
  email: string,
  inputOtp: string
): Promise<{ valid: boolean; expired: boolean }> {
  const emailLower = email.toLowerCase().trim();

  const { data, error } = await sb
    .from('otp_codes')
    .select('*')
    .eq('email', emailLower)
    .single();

  if (error || !data) {
    return { valid: false, expired: true };
  }

  // 期限チェック
  if (new Date(data.expires_at) < new Date()) {
    await sb.from('otp_codes').delete().eq('email', emailLower);
    return { valid: false, expired: true };
  }

  // 失敗回数チェック
  if (data.fail_count >= OTP_MAX_FAIL) {
    await sb.from('otp_codes').delete().eq('email', emailLower);
    return { valid: false, expired: true };
  }

  // コード照合
  if (inputOtp !== data.code) {
    await sb
      .from('otp_codes')
      .update({ fail_count: data.fail_count + 1 })
      .eq('email', emailLower);
    return { valid: false, expired: false };
  }

  // 成功 → OTP削除
  await sb.from('otp_codes').delete().eq('email', emailLower);
  return { valid: true, expired: false };
}

// =============================================
// 金額検証（GASの validateBookingTotal を移植）
// =============================================
async function validateBookingTotal(
  sb: ReturnType<typeof getSupabaseClient>,
  booking: Record<string, unknown>
): Promise<{ valid: boolean; serverTotal: number; reason: string }> {
  // configテーブルから設定を取得する代わりに、getShopConfig相当を直接定義
  // TODO: Phase 2で設定もSupabaseから取得するように変更
  const config = await getShopConfigFromEnv();

  const planDef = config.plans.find((p: { name: string }) => p.name === booking.plan);
  if (!planDef) return { valid: false, serverTotal: 0, reason: '不明なプラン: ' + booking.plan };

  // 見積もりプランは金額検証スキップ
  if (planDef.isEstimate) return { valid: true, serverTotal: 0, reason: '' };

  // 人数パース
  const peopleStr = String(booking.people || '');
  const fm = peopleStr.match(/女性(\d+)/);
  const mm = peopleStr.match(/男性(\d+)/);
  const cm = peopleStr.match(/小人(\d+)/);
  const female = fm ? parseInt(fm[1]) : 0;
  const male = mm ? parseInt(mm[1]) : 0;
  const child = cm ? parseInt(cm[1]) : 0;
  if (female + male + child === 0)
    return { valid: false, serverTotal: 0, reason: '人数不正' };

  // 基本料金
  let baseTotal =
    planDef.price * female + config.malePrice * male + config.childPrice * child;

  // オプション料金
  let optTotal = 0;
  const bookingOpts = (booking.options as Array<{ name: string; price: number }>) || [];
  for (const opt of bookingOpts) {
    const optName = String(opt.name || '');
    const optPrice = parseInt(String(opt.price)) || 0;

    // 特典（★付き）は price=0 であることを検証
    if (optName.indexOf('★') === 0) {
      if (optPrice !== 0)
        return { valid: false, serverTotal: 0, reason: '特典の価格が不正: ' + optName };
      continue;
    }

    // 数量付き（'ヘアセット×2' 形式）
    const qtyMatch = optName.match(/×(\d+)$/);
    const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
    const baseName = qtyMatch ? optName.replace(/×\d+$/, '') : optName;

    const optDef = config.options.find((o: { name: string }) => o.name === baseName);
    if (!optDef)
      return { valid: false, serverTotal: 0, reason: '不正なオプション: ' + baseName };

    const expectedPrice = optDef.price * qty;
    if (optPrice !== expectedPrice)
      return {
        valid: false,
        serverTotal: 0,
        reason: `オプション価格不一致: ${baseName} expected=${expectedPrice} got=${optPrice}`,
      };
    optTotal += expectedPrice;
  }

  let serverTotal = baseTotal + optTotal;

  // ポイント・クーポン控除
  if (booking.pointUsed && parseInt(String(booking.pointUsed)) > 0) {
    serverTotal -= parseInt(String(booking.pointUsed));
  }
  if (booking.couponUsed && parseInt(String(booking.couponUsed)) > 0) {
    serverTotal -= parseInt(String(booking.couponUsed));
  }
  if (serverTotal < 0) serverTotal = 0;

  const clientTotal = parseInt(String(booking.total)) || 0;
  if (clientTotal !== serverTotal)
    return {
      valid: false,
      serverTotal,
      reason: `合計不一致: server=${serverTotal} client=${clientTotal}`,
    };

  return { valid: true, serverTotal, reason: '' };
}

// 店舗設定を環境変数から取得（GASのgetShopConfigと同じ構造）
// Phase 2で settings テーブルに移行予定
async function getShopConfigFromEnv(): Promise<Record<string, unknown>> {
  const configJson = Deno.env.get('SHOP_CONFIG');
  if (configJson) {
    return JSON.parse(configJson);
  }
  // フォールバック: GASから取得してキャッシュ
  // GASのgetConfig APIを叩いて最新の設定を取得
  const gasUrl = Deno.env.get('GAS_URL');
  const accessKey = Deno.env.get('GAS_ACCESS_KEY');
  if (gasUrl && accessKey) {
    const res = await fetch(`${gasUrl}?key=${accessKey}&action=getConfig`);
    const data = await res.json();
    if (data.success && data.config) return data.config;
  }
  throw new Error('SHOP_CONFIG または GAS_URL が未設定です');
}

// =============================================
// PAY.JP決済（GASの createChargePayjp を移植）
// =============================================
async function createChargePayjp(
  cardToken: string,
  amount: number,
  description: string
): Promise<{ id: string; amount: number }> {
  const secretKey = Deno.env.get('PAYJP_SECRET_KEY');
  if (!secretKey) throw new Error('PAYJP_SECRET_KEY が設定されていません');

  const res = await fetch('https://api.pay.jp/v1/charges', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(secretKey + ':'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      amount: String(amount),
      currency: 'jpy',
      card: cardToken,
      description,
      capture: 'true',
    }),
  });

  const result = await res.json();
  if (result.error) {
    console.error('Pay.jp charge error:', result.error);
    throw new Error(result.error.message || '決済処理中にエラーが発生しました');
  }
  return result;
}

// PAY.JP返金（保存失敗時のロールバック用）
async function refundChargePayjp(chargeId: string): Promise<void> {
  const secretKey = Deno.env.get('PAYJP_SECRET_KEY');
  if (!secretKey || !chargeId) return;
  try {
    const res = await fetch(`https://api.pay.jp/v1/charges/${chargeId}/refund`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(secretKey + ':') },
    });
    const result = await res.json();
    if (result.error) {
      console.error('Pay.jp refund error:', result.error);
    }
  } catch (e) {
    console.error('Pay.jp refund exception:', e);
  }
}

// =============================================
// スロット空き確認（check-slotと同じロジック）
// =============================================
async function checkSlotAvailability(
  sb: ReturnType<typeof getSupabaseClient>,
  date: string,
  time: string
): Promise<{ remaining: number }> {
  const { data: bookings } = await sb
    .from('bookings')
    .select('time')
    .eq('date', date)
    .eq('time', time)
    .not('visit_status', 'in', '("paid-cancel","free-cancel")');

  const booked = bookings?.length || 0;

  // ブロック確認
  const { data: blocked } = await sb
    .from('blocked_slots')
    .select('time')
    .eq('date', date)
    .eq('time', time);

  // 設定ブロック確認
  const { data: settings } = await sb
    .from('settings')
    .select('blocked_slots')
    .eq('date', date)
    .single();

  const settingsBlocked =
    settings?.blocked_slots?.includes(time) || false;

  if (blocked?.length || settingsBlocked || booked >= SLOT_CAPACITY) {
    return { remaining: 0 };
  }
  return { remaining: SLOT_CAPACITY - booked };
}

// =============================================
// メール送信（Resend）
// =============================================
async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY が未設定');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: Deno.env.get('RESEND_FROM') || 'きものレンタル あかり <onboarding@resend.dev>',
        to: [to],
        subject,
        text,
      }),
    });
    return res.ok;
  } catch (e) {
    console.error('メール送信エラー:', e);
    return false;
  }
}

// 予約確認メール（GASの sendConfirmationEmail を移植）
async function sendConfirmationEmail(booking: Record<string, unknown>): Promise<boolean> {
  if (!booking.email) return false;
  const dateStr = formatBookingDate(String(booking.date));
  const optStr = formatOptions(booking.options as Array<{ name: string }> | null);
  const totalStr =
    (booking.total as number) > 0
      ? `¥${(booking.total as number).toLocaleString()}（税込）`
      : '来店時お見積もり';

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
${SITE_BASE_URL}/my-reservation.html?id=${booking.reservationId}

当日のご来店をお待ちしております。

──────────────────────────────
※ このメールは自動送信です。ご返信はお受けできません。`;

  return await sendEmail(String(booking.email), subject, body);
}

// 管理者通知メール（GASの sendAdminNotification を移植）
async function sendAdminNotification(booking: Record<string, unknown>): Promise<void> {
  const dateStr = formatBookingDate(String(booking.date));
  const optStr = formatOptions(booking.options as Array<{ name: string }> | null);
  const totalStr =
    (booking.total as number) > 0
      ? `¥${(booking.total as number).toLocaleString()}`
      : '来店時お見積もり';

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

  await sendEmail(ADMIN_EMAIL, subject, body);
}

// =============================================
// メインハンドラ
// =============================================
serve(async (req) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const data = await req.json();
    const booking = data.booking;
    const otp = data.otp;
    const cardToken = data.cardToken;

    // ── サーバー側入力バリデーション ─────────────────
    if (!booking || !booking.date || !booking.time || !booking.name || !booking.email) {
      return errorResponse('必須項目が不足しています', 400, 'VALIDATION');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(booking.date)) {
      return errorResponse('日付形式が不正です', 400, 'VALIDATION');
    }
    if (!ALL_TIMES.includes(booking.time)) {
      return errorResponse('時間が不正です', 400, 'VALIDATION');
    }

    // 過去の日付チェック（JST基準）
    const bookingDate = new Date(booking.date + 'T00:00:00+09:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (bookingDate < today) {
      return errorResponse('過去の日付は指定できません', 400, 'VALIDATION');
    }

    if (booking.email && !isValidEmail(booking.email)) {
      return errorResponse('メールアドレスが不正です', 400, 'VALIDATION');
    }

    // 入力サニタイズ
    booking.name = String(booking.name || '').trim().substring(0, 100);
    booking.remarks = String(booking.remarks || '').trim().substring(0, 500);
    booking.tel = String(booking.tel || '')
      .replace(/[^\d\-+()./ ]/g, '')
      .substring(0, 30);

    // ── 定休日チェック ────────────────────────────
    const bookingDow = new Date(booking.date + 'T00:00:00+09:00').getDay();
    if (bookingDow === 3) {
      return errorResponse('水曜日は定休日のため予約できません', 400, 'VALIDATION');
    }

    const sb = getSupabaseClient();

    // 設定による休業日チェック
    const { data: dateSetting } = await sb
      .from('settings')
      .select('closed')
      .eq('date', booking.date)
      .single();

    if (dateSetting?.closed) {
      return errorResponse('この日は休業日のため予約できません', 400, 'VALIDATION');
    }

    // ── サーバーサイド金額検証 ─────────────────────
    const amountCheck = await validateBookingTotal(sb, booking);
    if (!amountCheck.valid) {
      console.error('金額検証失敗:', amountCheck.reason);
      return errorResponse(
        '金額の検証に失敗しました。ページを再読み込みしてやり直してください。',
        400,
        'AMOUNT_MISMATCH'
      );
    }

    // ── カード決済の整合性チェック ──────────────────
    if (booking.paymentMethod === 'card') {
      if (!booking.total || booking.total <= 0) {
        return errorResponse('金額が0円の場合はカード決済できません', 400, 'VALIDATION');
      }
      if (!cardToken) {
        return errorResponse('カードトークンが不足しています', 400, 'VALIDATION');
      }
    }

    // ── レート制限（同一メール: 5分間に3件まで）──────
    const emailLower = booking.email.toLowerCase().trim();
    const now = new Date();
    const { data: rateData } = await sb
      .from('booking_rate_limits')
      .select('*')
      .eq('email', emailLower)
      .single();

    if (rateData) {
      const elapsed = (now.getTime() - new Date(rateData.window_start).getTime()) / 1000;
      if (elapsed < BOOKING_RATE_WINDOW_SEC && rateData.booking_count >= BOOKING_RATE_LIMIT) {
        return errorResponse('送信回数の上限に達しました。5分後にお試しください。', 429, 'RATE_LIMIT');
      }
      if (elapsed >= BOOKING_RATE_WINDOW_SEC) {
        await sb.from('booking_rate_limits').upsert({
          email: emailLower,
          booking_count: 1,
          window_start: now.toISOString(),
        });
      } else {
        await sb.from('booking_rate_limits').upsert({
          email: emailLower,
          booking_count: rateData.booking_count + 1,
          window_start: rateData.window_start,
        });
      }
    } else {
      await sb.from('booking_rate_limits').upsert({
        email: emailLower,
        booking_count: 1,
        window_start: now.toISOString(),
      });
    }

    // ── OTP検証 ───────────────────────────────────
    const otpResult = await verifyOtp(sb, booking.email, otp || '');
    if (!otpResult.valid) {
      return errorResponse(
        otpResult.expired ? '確認コードの有効期限が切れました' : '確認コードが違います',
        400,
        otpResult.expired ? 'OTP_EXPIRED' : 'OTP_INVALID'
      );
    }

    // ── 冪等性チェック ────────────────────────────
    if (booking.reservationId) {
      const { data: existing } = await sb
        .from('bookings')
        .select('id')
        .eq('reservation_id', booking.reservationId)
        .single();

      if (existing) {
        return successResponse({ duplicate: true });
      }
    }

    // ── 空き確認 ──────────────────────────────────
    const slotCheck = await checkSlotAvailability(sb, booking.date, booking.time);
    if (slotCheck.remaining <= 0) {
      return errorResponse('この時間帯は満席です', 400, 'SLOT_FULL');
    }

    // ── PAY.JP カード決済 ────────────────────────
    let chargeId: string | null = null;
    let paymentStatus = 'pending';

    if (booking.paymentMethod === 'card' && cardToken && booking.total > 0) {
      try {
        const charge = await createChargePayjp(
          cardToken,
          booking.total,
          'きものレンタル あかり / ' + booking.plan + ' / ' + booking.name
        );
        chargeId = charge.id;
        paymentStatus = 'paid';
        console.log('Pay.jp 課金成功:', charge.id, '¥' + charge.amount);
      } catch (chargeErr) {
        console.error('決済失敗:', (chargeErr as Error).message);
        return errorResponse((chargeErr as Error).message, 400, 'CHARGE_FAILED');
      }
    }

    // ── DB保存 ────────────────────────────────────
    const bookingRecord = {
      id: booking.id || booking.reservationId,
      reservation_id: booking.reservationId,
      source: 'WEB',
      date: booking.date,
      time: booking.time,
      name: booking.name,
      email: booking.email,
      tel: booking.tel || null,
      plan: booking.plan,
      people: booking.people || null,
      options: booking.options || [],
      total: booking.total || 0,
      payment: booking.paymentMethod || null,
      remarks: booking.remarks || null,
      charge_id: chargeId,
      payment_status: paymentStatus,
      visit_status: 'confirmed',
      channel: booking.channel || 'WEB',
      created_at: new Date().toISOString(),
    };

    const { error: insertError } = await sb.from('bookings').insert(bookingRecord);

    if (insertError) {
      console.error('保存失敗:', insertError);
      // 決済済みの場合は返金
      if (chargeId) {
        console.log('保存失敗のため返金実行:', chargeId);
        await refundChargePayjp(chargeId);
      }
      return errorResponse('予約の保存に失敗しました', 500);
    }

    // 保存確認
    const { data: saved } = await sb
      .from('bookings')
      .select('id')
      .eq('reservation_id', booking.reservationId)
      .single();

    if (!saved) {
      console.error('CRITICAL: 保存確認失敗 id=' + booking.id);
      if (chargeId) {
        await refundChargePayjp(chargeId);
      }
      return errorResponse('予約の保存に失敗しました', 500);
    }

    // ── メール送信（失敗しても予約は有効）──────────
    let emailOk = true;
    try {
      emailOk = await sendConfirmationEmail(booking);
    } catch (e) {
      emailOk = false;
      console.error('確認メール送信失敗:', e);
    }

    try {
      await sendAdminNotification(booking);
    } catch (e) {
      console.error('管理者通知送信失敗:', e);
    }

    return successResponse({
      reservationId: booking.reservationId,
      emailSent: emailOk,
    });
  } catch (err) {
    console.error('save-booking error:', err);
    return errorResponse('予約処理に失敗しました', 500);
  }
});
