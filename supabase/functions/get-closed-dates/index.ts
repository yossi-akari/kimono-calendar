// get-closed-dates: 指定範囲内の臨時休業日一覧を返す
// reserve.htmlのflatpickrカレンダーで「グレーアウト+クリック不可」表示するために使う。
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { handleCors } from '../_shared/cors.ts';
import { getSupabaseClient } from '../_shared/supabase.ts';
import { successResponse, errorResponse } from '../_shared/response.ts';

serve(async (req) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const { from, to } = await req.json();
    // 簡易バリデーション: YYYY-MM-DD のみ受け付け
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return errorResponse('from が不正です（YYYY-MM-DD形式）');
    }
    if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return errorResponse('to が不正です（YYYY-MM-DD形式）');
    }

    const sb = getSupabaseClient();

    // settings テーブルから「closed=true かつ from <= date <= to」の行を取得
    // DEFAULT 行は date='DEFAULT' なので範囲フィルタで自動的に除外される
    const { data, error } = await sb
      .from('settings')
      .select('date, note')
      .eq('closed', true)
      .gte('date', from)
      .lte('date', to);

    if (error) throw error;

    const closedDates = (data || []).map((row: { date: string; note: string | null }) => ({
      date: row.date,
      note: row.note || '',
    }));

    return successResponse({ closedDates });
  } catch (err) {
    console.error('get-closed-dates error:', err);
    return errorResponse('休業日情報の取得に失敗しました', 500);
  }
});
