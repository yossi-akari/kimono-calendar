-- =============================================
-- booking_requests テーブル
-- お客様が my-reservation.html から送信する変更/キャンセル申請を保存
-- 2026-04-18 追加（GAS sheet からの段階移行）
-- =============================================

CREATE TABLE booking_requests (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,            -- 表示用ID (REQ-{timestamp})
  booking_id TEXT NOT NULL,                   -- bookings.reservation_id を参照
  booking_name TEXT,                          -- 予約者名のスナップショット（表示用）
  type TEXT NOT NULL,                         -- 'change' | 'cancel'
  status TEXT NOT NULL DEFAULT 'pending',     -- 'pending' | 'approved' | 'rejected'
  new_date DATE,                              -- 変更希望日（type='change'のみ）
  new_time TIME,                              -- 変更希望時刻（type='change'のみ）
  message TEXT,                               -- お客様からのメッセージ
  admin_note TEXT,                            -- 管理者メモ（却下理由など）
  submitted_at TIMESTAMPTZ DEFAULT NOW(),     -- 申請日時
  processed_at TIMESTAMPTZ                    -- 承認/却下日時
);

CREATE INDEX idx_booking_requests_booking_id ON booking_requests (booking_id);
CREATE INDEX idx_booking_requests_status ON booking_requests (status);
CREATE INDEX idx_booking_requests_submitted ON booking_requests (submitted_at DESC);

-- RLS有効化（anonアクセス禁止、Edge FunctionsはService Roleで操作）
ALTER TABLE booking_requests ENABLE ROW LEVEL SECURITY;
