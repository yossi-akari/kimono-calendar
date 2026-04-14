-- 予約システム Supabase移行: テーブル作成
-- GASの手動予約シート・設定シート・スロットブロックシートに対応

-- =============================================
-- 予約データ（GASの「手動予約」シート相当）
-- =============================================
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,                        -- HP-{timestamp}-{random} 形式
  reservation_id TEXT UNIQUE NOT NULL,        -- 表示用予約ID（HP-XXXXX）
  source TEXT NOT NULL DEFAULT 'WEB',         -- WEB / MANUAL / AJ / JALAN
  date DATE NOT NULL,
  time TIME NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  tel TEXT,
  plan TEXT NOT NULL,
  people TEXT,                                -- 例: "女性2名・男性1名"
  options JSONB DEFAULT '[]'::jsonb,          -- [{name, price}, ...]
  total INTEGER DEFAULT 0,
  payment TEXT,                               -- card / cash / paypal 等
  remarks TEXT,
  charge_id TEXT,                             -- PAY.JP charge ID
  payment_status TEXT DEFAULT 'pending',      -- pending / paid
  visit_status TEXT DEFAULT 'confirmed',      -- confirmed / visited / paid-cancel / free-cancel
  channel TEXT,                               -- 予約チャネル
  status_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 日付・予約元で検索するためのインデックス
CREATE INDEX idx_bookings_date ON bookings (date);
CREATE INDEX idx_bookings_source ON bookings (source);
CREATE INDEX idx_bookings_date_time ON bookings (date, time);

-- =============================================
-- 日付ごとの設定（GASの「設定」シート相当）
-- =============================================
CREATE TABLE settings (
  date TEXT PRIMARY KEY,                      -- YYYY-MM-DD または 'DEFAULT'
  slot_limit INTEGER,                         -- その日の予約上限
  closed BOOLEAN DEFAULT FALSE,               -- 休業日フラグ
  note TEXT,                                  -- メモ
  photo_limit INTEGER DEFAULT 2,              -- 撮影プラン上限
  photo_blocked_slots TEXT[] DEFAULT '{}',     -- 撮影ブロックされた時間帯
  blocked_slots TEXT[] DEFAULT '{}'            -- ブロックされた時間帯
);

-- =============================================
-- スロットブロック（GASの「スロットブロック」シート相当）
-- =============================================
CREATE TABLE blocked_slots (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  time TIME NOT NULL,
  reason TEXT,
  UNIQUE(date, time)
);

CREATE INDEX idx_blocked_slots_date ON blocked_slots (date);

-- =============================================
-- OTP一時保存（GASのCacheService相当）
-- =============================================
CREATE TABLE otp_codes (
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  fail_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- 期限切れOTPを自動削除するためのインデックス
CREATE INDEX idx_otp_expires ON otp_codes (expires_at);

-- =============================================
-- OTPレート制限（GASのCacheService相当）
-- =============================================
CREATE TABLE otp_rate_limits (
  email TEXT PRIMARY KEY,
  send_count INTEGER DEFAULT 1,
  window_start TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 予約レート制限
-- =============================================
CREATE TABLE booking_rate_limits (
  email TEXT PRIMARY KEY,
  booking_count INTEGER DEFAULT 1,
  window_start TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- Row Level Security（RLS）
-- Edge Functionsからはservice_roleキーで接続するのでRLSをバイパスするが、
-- anon/publicからの直接アクセスを防ぐために有効化
-- =============================================
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_rate_limits ENABLE ROW LEVEL SECURITY;

-- anonユーザーからの直接アクセスは拒否（Edge Functionsはservice_roleを使う）
-- 将来的に管理画面をSupabase経由にする際にはここにポリシーを追加
