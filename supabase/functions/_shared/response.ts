// JSON応答ヘルパー: CORSヘッダー付きでJSON応答を返す
import { corsHeaders } from './cors.ts';

export function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function errorResponse(error: string, status = 400, code?: string): Response {
  return jsonResponse({ success: false, error: code || error, message: error }, status);
}

export function successResponse(data: Record<string, unknown> = {}): Response {
  return jsonResponse({ success: true, ...data });
}
