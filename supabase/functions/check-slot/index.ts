// check-slot: 指定日のスロット空き状況を返す
// GASの getSlotAvailability() を移植
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { handleCors } from '../_shared/cors.ts';
import { getSupabaseClient } from '../_shared/supabase.ts';
import { successResponse, errorResponse } from '../_shared/response.ts';

// GASと同じ定数
const SLOT_CAPACITY = 1;
const ALL_TIMES = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
  '12:00', '12:30', '13:00', '13:30', '14:00',
];

serve(async (req) => {
  // CORSプリフライト
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const { date } = await req.json();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return errorResponse('日付が不正です（YYYY-MM-DD形式）');
    }

    const sb = getSupabaseClient();

    // 3つのデータを並列で取得（GASと同じ3つのソースに相当）
    const [bookingsRes, blockedRes, settingsRes] = await Promise.all([
      // その日の有効な予約（キャンセル済みを除く）
      sb.from('bookings')
        .select('time, plan')
        .eq('date', date)
        .not('visit_status', 'in', '("paid-cancel","free-cancel")'),

      // その日のスロットブロック
      sb.from('blocked_slots')
        .select('time, reason')
        .eq('date', date),

      // その日の設定（DEFAULT設定もフォールバック用に取得）
      sb.from('settings')
        .select('*')
        .in('date', [date, 'DEFAULT']),
    ]);

    if (bookingsRes.error) throw bookingsRes.error;
    if (blockedRes.error) throw blockedRes.error;
    if (settingsRes.error) throw settingsRes.error;

    const bookings = bookingsRes.data || [];
    const blockedList = blockedRes.data || [];
    const settingsRows = settingsRes.data || [];

    // 設定: 日付固有の設定 → DEFAULT のフォールバック
    const dateSetting = settingsRows.find((s) => s.date === date) || {};
    const defaultSetting = settingsRows.find((s) => s.date === 'DEFAULT') || {};
    const photoLimit =
      dateSetting.photo_limit ?? defaultSetting.photo_limit ?? 2;
    const photoBlockedSlots = new Set(dateSetting.photo_blocked_slots || []);
    const settingsBlockedSlots = new Set(dateSetting.blocked_slots || []);

    // ブロックされたスロットをセットに変換
    const blockedTimes = new Set(blockedList.map((b: { time: string }) => b.time.substring(0, 5)));
    const blockedReasons: Record<string, string> = {};
    blockedList.forEach((b: { time: string; reason: string }) => {
      blockedReasons[b.time.substring(0, 5)] = b.reason || '';
    });

    // 撮影プランの予約数（日全体）
    const totalPhotoBooked = bookings.filter(
      (b: { plan: string }) => b.plan && b.plan.indexOf('撮影') >= 0
    ).length;

    // 各時間帯のスロット状況を計算
    const slots: Record<string, unknown> = {};
    for (const t of ALL_TIMES) {
      const booked = bookings.filter(
        (b: { time: string }) => b.time.substring(0, 5) === t
      ).length;
      const blocked =
        blockedTimes.has(t) || settingsBlockedSlots.has(t);
      const photoBlocked = photoBlockedSlots.has(t);

      slots[t] = {
        booked,
        blocked,
        reason: blockedReasons[t] || '',
        remaining:
          blocked || booked >= SLOT_CAPACITY ? 0 : SLOT_CAPACITY - booked,
        photoBlocked,
        photoRemaining:
          photoBlocked || totalPhotoBooked >= photoLimit
            ? 0
            : photoLimit - totalPhotoBooked,
      };
    }

    return successResponse({ slots, capacity: SLOT_CAPACITY });
  } catch (err) {
    console.error('check-slot error:', err);
    return errorResponse('スロット情報の取得に失敗しました', 500);
  }
});
