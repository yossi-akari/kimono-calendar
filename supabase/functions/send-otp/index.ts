// send-otp: メール確認コード（OTP）を生成して送信
// GASの issueBookingOtp() + OTPレート制限を移植
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { handleCors } from '../_shared/cors.ts';
import { getSupabaseClient } from '../_shared/supabase.ts';
import { successResponse, errorResponse } from '../_shared/response.ts';

// GASと同じ定数
const OTP_DIGITS = 6;
const OTP_TTL_SEC = 600; // 10分
const OTP_MAX_SEND = 3;  // 10分間に最大3回
const OTP_RATE_WINDOW_SEC = 600;

// 6桁のOTPを生成
function generateOtp(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(OTP_DIGITS, '0');
}

// メールアドレスの簡易バリデーション
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

serve(async (req) => {
  const corsRes = handleCors(req);
  if (corsRes) return corsRes;

  try {
    const { email } = await req.json();

    if (!email || !isValidEmail(email)) {
      return errorResponse('メールアドレスが不正です');
    }

    const emailLower = email.toLowerCase().trim();
    const sb = getSupabaseClient();
    const now = new Date();

    // レート制限チェック: 10分間に3回まで
    const { data: rateData } = await sb
      .from('otp_rate_limits')
      .select('*')
      .eq('email', emailLower)
      .single();

    if (rateData) {
      const windowStart = new Date(rateData.window_start);
      const elapsed = (now.getTime() - windowStart.getTime()) / 1000;

      if (elapsed < OTP_RATE_WINDOW_SEC && rateData.send_count >= OTP_MAX_SEND) {
        return errorResponse('送信回数の上限に達しました。しばらくしてからお試しください。', 429, 'OTP_RATE_LIMIT');
      }

      if (elapsed >= OTP_RATE_WINDOW_SEC) {
        // ウィンドウをリセット
        await sb.from('otp_rate_limits').upsert({
          email: emailLower,
          send_count: 1,
          window_start: now.toISOString(),
        });
      } else {
        // カウントを増やす
        await sb.from('otp_rate_limits').upsert({
          email: emailLower,
          send_count: rateData.send_count + 1,
          window_start: rateData.window_start,
        });
      }
    } else {
      // 初回送信
      await sb.from('otp_rate_limits').upsert({
        email: emailLower,
        send_count: 1,
        window_start: now.toISOString(),
      });
    }

    // OTP生成・保存
    const otp = generateOtp();
    const expiresAt = new Date(now.getTime() + OTP_TTL_SEC * 1000);

    await sb.from('otp_codes').upsert({
      email: emailLower,
      code: otp,
      fail_count: 0,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    });

    // Resendでメール送信
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) {
      console.error('RESEND_API_KEY が設定されていません');
      return errorResponse('メール送信の設定に問題があります', 500);
    }

    // GASと同じメール本文
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
      'If you did not request this, please ignore this email.',
    ].join('\n');

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      // ドメイン検証完了後は reserve@akari-kanazawa.jp に切り替え
      // 環境変数 RESEND_FROM で送信元を切り替え可能
      body: JSON.stringify({
        from: Deno.env.get('RESEND_FROM') || 'きものレンタル あかり <onboarding@resend.dev>',
        to: [emailLower],
        subject,
        text: body,
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend送信失敗:', errBody);
      return errorResponse('メール送信に失敗しました', 500);
    }

    return successResponse();
  } catch (err) {
    console.error('send-otp error:', err);
    return errorResponse('OTP送信に失敗しました', 500);
  }
});
