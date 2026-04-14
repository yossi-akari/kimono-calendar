// config: 店舗設定（プラン・オプション・営業時間等）を返す
// GASの doGet getConfig → getShopConfig() を移植
//
// 設定の変更方法:
//   環境変数 SHOP_CONFIG にJSON文字列をセットする
//   または GAS_URL + GAS_ACCESS_KEY を設定してGASから取得する
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { handleCors } from '../_shared/cors.ts';
import { successResponse, errorResponse } from '../_shared/response.ts';

// 設定キャッシュ（コールドスタート対策: 1回取得すれば再利用）
let cachedConfig: Record<string, unknown> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分

serve(async (req) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const now = Date.now();

    // キャッシュが有効ならそのまま返す（期間限定プランのフィルタリングのみ再実行）
    if (!cachedConfig || now - cachedAt > CACHE_TTL_MS) {
      cachedConfig = await loadConfig();
      cachedAt = now;
    }

    // 期間限定プランのフィルタリング（日付が変わる可能性があるので毎回実行）
    const config = JSON.parse(JSON.stringify(cachedConfig)); // deep copy
    const today = new Date()
      .toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD

    if (Array.isArray(config.plans)) {
      config.plans = config.plans.filter((p: Record<string, string>) => {
        if (!p.periodEnd) return true;
        if (p.periodStart && today < p.periodStart) return false;
        if (p.periodEnd && today > p.periodEnd) return false;
        return true;
      });
      // 期間限定プランを先頭に移動
      config.plans.sort(
        (a: Record<string, string>, b: Record<string, string>) => {
          const aLimited = a.periodEnd ? 0 : 1;
          const bLimited = b.periodEnd ? 0 : 1;
          return aLimited - bLimited;
        }
      );
    }

    return successResponse({ config });
  } catch (err) {
    console.error('config error:', err);
    return errorResponse('設定の取得に失敗しました', 500);
  }
});

// 設定を読み込む（環境変数 or GAS経由）
async function loadConfig(): Promise<Record<string, unknown>> {
  // 方法1: 環境変数から直接取得（推奨）
  const configJson = Deno.env.get('SHOP_CONFIG');
  if (configJson) {
    return JSON.parse(configJson);
  }

  // 方法2: GASのgetConfig APIから取得（フォールバック）
  const gasUrl = Deno.env.get('GAS_URL');
  const accessKey = Deno.env.get('GAS_ACCESS_KEY');
  if (gasUrl && accessKey) {
    const res = await fetch(`${gasUrl}?key=${accessKey}&action=getConfig`);
    const data = await res.json();
    if (data.success && data.config) {
      return data.config;
    }
    throw new Error('GASからの設定取得に失敗: ' + JSON.stringify(data));
  }

  throw new Error('SHOP_CONFIG または GAS_URL/GAS_ACCESS_KEY が未設定です');
}
