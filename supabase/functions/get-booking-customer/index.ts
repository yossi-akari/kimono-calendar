// =============================================
// 顧客向け予約照会 Edge Function
// my-reservation.html から呼ばれる。予約番号+メールで照合し、
// 未処理の変更/キャンセル申請があれば一緒に返す。
// =============================================
// GASの getBookingForCustomer + getPendingRequestForBooking を移植

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, errorResponse, successResponse } from '../_shared/response.ts';
import { getSupabaseClient } from '../_shared/supabase.ts';

serve(async (req) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const data = await req.json();
    const id = String(data.id || '').trim();
    const email = String(data.email || '').toLowerCase().trim();

    if (!id || !email) {
      return errorResponse('予約番号とメールアドレスを入力してください', 400, 'VALIDATION');
    }
    if (!id.startsWith('HP-')) {
      return errorResponse('このページではウェブ予約（HP-から始まる予約番号）のみ確認できます', 400, 'VALIDATION');
    }

    const sb = getSupabaseClient();

    // ── 予約照合 ─────────────────────────
    // reservation_id 一致 + email 大文字小文字無視で一致
    const { data: bookings, error: bookingErr } = await sb
      .from('bookings')
      .select('reservation_id, date, time, name, plan, people, options, total, payment, email, tel, remarks, visit_status, channel')
      .eq('reservation_id', id)
      .limit(5);

    if (bookingErr) {
      console.error('bookings 検索エラー:', bookingErr);
      return errorResponse('予約照会に失敗しました', 500);
    }

    const matched = (bookings || []).find(
      (b: Record<string, unknown>) => String(b.email || '').toLowerCase().trim() === email
    );

    if (!matched) {
      return errorResponse('予約が見つかりません。予約番号またはメールアドレスをご確認ください。', 404, 'NOT_FOUND');
    }

    // ── 未処理申請の取得 ─────────────────
    const { data: pendingRows, error: reqErr } = await sb
      .from('booking_requests')
      .select('request_id, type, new_date, new_time, message, submitted_at')
      .eq('booking_id', id)
      .eq('status', 'pending')
      .order('submitted_at', { ascending: false })
      .limit(1);

    if (reqErr) {
      console.error('booking_requests 検索エラー:', reqErr);
      // 申請取得失敗でも予約自体は返す（degraded mode）
    }

    const pendingRow = (pendingRows && pendingRows[0]) || null;
    const pendingRequest = pendingRow
      ? {
          requestId:   pendingRow.request_id,
          type:        pendingRow.type,
          newDate:     pendingRow.new_date || '',
          newTime:     pendingRow.new_time || '',
          message:     pendingRow.message || '',
          submittedAt: pendingRow.submitted_at,
        }
      : null;

    // ── 顧客向けに返す形式に整形 ─────────
    const booking = {
      id:            matched.reservation_id,
      reservationId: matched.reservation_id,
      date:          matched.date,
      time:          matched.time,
      name:          matched.name,
      plan:          matched.plan,
      people:        matched.people || '',
      options:       matched.options || [],
      total:         matched.total || 0,
      payment:       matched.payment || '',
      email:         matched.email,
      tel:           matched.tel || '',
      remarks:       matched.remarks || '',
      visitStatus:   matched.visit_status || 'confirmed',
      channel:       matched.channel || 'WEB',
    };

    return successResponse({ booking, pendingRequest });
  } catch (err) {
    console.error('get-booking-customer 例外:', err);
    return errorResponse('内部エラーが発生しました', 500);
  }
});
