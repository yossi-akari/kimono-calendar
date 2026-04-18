// =============================================
// 顧客向け 予約変更/キャンセル申請 Edge Function
// my-reservation.html から呼ばれる。
// =============================================
// GASの submitRequest + sendRequestNotification を移植

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/response.ts';
import { getSupabaseClient } from '../_shared/supabase.ts';

const ADMIN_EMAIL = Deno.env.get('ADMIN_EMAIL') || 'rentalakari@gmail.com';

// 日付文字列(YYYY-MM-DD)から曜日を取得（タイムゾーン非依存）
function getDayOfWeekFromDateStr(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
const DAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
function formatBookingDate(dateStr: string): string {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${y}年${m}月${d}日（${DAY_JA[getDayOfWeekFromDateStr(dateStr)]}）`;
}

// メール送信（Resend）
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

serve(async (req) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const data = await req.json();
    const id = String(data.id || '').trim();
    const email = String(data.email || '').toLowerCase().trim();
    const type = String(data.type || '').trim();
    const newDate = String(data.newDate || '').trim();
    const newTime = String(data.newTime || '').trim();
    const message = String(data.message || '').trim().substring(0, 500);

    // ── バリデーション ─────────────────────
    if (!id || !email || !type) {
      return errorResponse('パラメータが不足しています', 400, 'VALIDATION');
    }
    if (type !== 'change' && type !== 'cancel') {
      return errorResponse('申請タイプが不正です', 400, 'VALIDATION');
    }
    if (!id.startsWith('HP-')) {
      return errorResponse('このページではウェブ予約のみ申請可能です', 400, 'VALIDATION');
    }
    if (type === 'change' && newDate && !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
      return errorResponse('日付形式が不正です', 400, 'VALIDATION');
    }

    const sb = getSupabaseClient();

    // ── 予約照合 ─────────────────────────
    const { data: bookings, error: bookingErr } = await sb
      .from('bookings')
      .select('reservation_id, date, time, name, email, plan, people')
      .eq('reservation_id', id)
      .limit(5);

    if (bookingErr) {
      console.error('bookings 検索エラー:', bookingErr);
      return errorResponse('予約照会に失敗しました', 500);
    }

    const booking = (bookings || []).find(
      (b: Record<string, unknown>) => String(b.email || '').toLowerCase().trim() === email
    );
    if (!booking) {
      return errorResponse('予約が見つかりません', 404, 'NOT_FOUND');
    }

    // ── 重複申請チェック ───────────────
    const { data: existing } = await sb
      .from('booking_requests')
      .select('request_id')
      .eq('booking_id', id)
      .eq('status', 'pending')
      .limit(1);

    if (existing && existing.length > 0) {
      return errorResponse('この予約にはすでに申請中のリクエストがあります', 409, 'DUPLICATE');
    }

    // ── 申請を保存 ─────────────────────
    const requestId = 'REQ-' + Date.now();
    const { error: insertErr } = await sb.from('booking_requests').insert({
      request_id:   requestId,
      booking_id:   id,
      booking_name: booking.name,
      type,
      status:       'pending',
      new_date:     type === 'change' && newDate ? newDate : null,
      new_time:     type === 'change' && newTime ? newTime : null,
      message:      message || null,
      submitted_at: new Date().toISOString(),
    });

    if (insertErr) {
      console.error('booking_requests INSERT エラー:', insertErr);
      return errorResponse('申請の保存に失敗しました', 500);
    }

    // ── 管理者にメール通知（失敗しても申請自体は成功扱い）──
    try {
      const typeLabel = type === 'cancel' ? 'キャンセル' : '日時変更';
      const subject = `【予約${typeLabel}申請】${booking.name} 様（${booking.date}）`;
      const body =
        `予約の${typeLabel}申請が届きました。\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n元のご予約\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `予約番号：${booking.reservation_id}\n` +
        `お名前  ：${booking.name}\n` +
        `来店日時：${formatBookingDate(String(booking.date))} ${booking.time}\n` +
        `プラン  ：${booking.plan}\n` +
        `人数    ：${booking.people || '—'}\n` +
        (type === 'change'
          ? `━━━━━━━━━━━━━━━━━━━━━━━━━━\n希望する変更内容\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `新しい日時：${newDate ? formatBookingDate(newDate) : '—'}　${newTime || '—'}\n`
          : '') +
        (message ? `お客様メッセージ：${message}\n` : '') +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `申請番号：${requestId}\n` +
        `申請日時：${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`;
      await sendEmail(ADMIN_EMAIL, subject, body);
    } catch (e) {
      console.error('管理者通知メール失敗:', e);
    }

    return successResponse({ requestId });
  } catch (err) {
    console.error('submit-request 例外:', err);
    return errorResponse('内部エラーが発生しました', 500);
  }
});
