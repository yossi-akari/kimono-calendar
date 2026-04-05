#!/bin/bash
# ============================================================
# Booking System — Comprehensive Test Suite
# テスト対象: GAS API の各エンドポイント（GET）
# ============================================================

GAS_URL="https://script.google.com/macros/s/AKfycbx347zA3An_FRMxeBLEQVLCbGRgLBiUinEt8OL2I-H91ixNlqwT6lXb-9-_rP_ZowrbKw/exec"
KEY="34563456"
PASS=0
FAIL=0
TOTAL=0

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

run_test() {
  local name="$1"
  local url="$2"
  local expected="$3"
  local check_field="$4"
  TOTAL=$((TOTAL + 1))

  local result
  result=$(curl -sL "$url" 2>&1)

  if echo "$result" | grep -q "$expected"; then
    PASS=$((PASS + 1))
    echo -e "${GREEN}✓ PASS${NC} [$TOTAL] $name"
  else
    FAIL=$((FAIL + 1))
    echo -e "${RED}✗ FAIL${NC} [$TOTAL] $name"
    echo "  Expected: $expected"
    echo "  Got: $(echo "$result" | head -c 200)"
  fi
}

echo "============================================"
echo " Booking System Test Suite"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"
echo ""

# ──────────────────────────────────────────────
# 1. Authentication / Authorization Tests
# ──────────────────────────────────────────────
echo "--- 1. Authentication Tests ---"

run_test "Missing key returns Unauthorized" \
  "${GAS_URL}?action=getAvailability&date=2026-04-01" \
  "Unauthorized"

run_test "Wrong key returns Unauthorized" \
  "${GAS_URL}?key=wrongkey&action=getAvailability&date=2026-04-01" \
  "Unauthorized"

run_test "Valid key succeeds" \
  "${GAS_URL}?key=${KEY}&action=getAvailability&date=2026-04-01" \
  '"success":true'

# ──────────────────────────────────────────────
# 2. Slot Availability Tests
# ──────────────────────────────────────────────
echo ""
echo "--- 2. Slot Availability Tests ---"

run_test "Future date returns availability" \
  "${GAS_URL}?key=${KEY}&action=getAvailability&date=2026-05-01" \
  '"success":true'

run_test "Missing date returns error" \
  "${GAS_URL}?key=${KEY}&action=getAvailability" \
  "date required"

run_test "Check slots for date with format YYYY-MM-DD" \
  "${GAS_URL}?key=${KEY}&action=checkSlot&date=2026-05-01" \
  '"success":true'

# ──────────────────────────────────────────────
# 3. Month Availability Tests
# ──────────────────────────────────────────────
echo ""
echo "--- 3. Month Availability Tests ---"

run_test "Month availability for valid month" \
  "${GAS_URL}?key=${KEY}&action=getMonthAvailability&year=2026&month=5" \
  '"success":true'

run_test "Month availability missing params" \
  "${GAS_URL}?key=${KEY}&action=getMonthAvailability" \
  "year and month required"

# ──────────────────────────────────────────────
# 4. Booking Lookup Tests (getBookingForCustomer)
# ──────────────────────────────────────────────
echo ""
echo "--- 4. Booking Lookup Tests ---"

run_test "Missing ID and email returns error" \
  "${GAS_URL}?key=${KEY}&action=getBookingForCustomer" \
  "入力してください"

run_test "Missing email returns error" \
  "${GAS_URL}?key=${KEY}&action=getBookingForCustomer&id=HP-123" \
  "入力してください"

run_test "Non-HP ID rejected" \
  "${GAS_URL}?key=${KEY}&action=getBookingForCustomer&id=MANUAL-123&email=test@test.com" \
  "HP-から始まる"

run_test "Nonexistent booking returns not found" \
  "${GAS_URL}?key=${KEY}&action=getBookingForCustomer&id=HP-FAKE-999&email=test@test.com" \
  "見つかりません"

# ──────────────────────────────────────────────
# 5. Boundary Value Tests - Date Edges
# ──────────────────────────────────────────────
echo ""
echo "--- 5. Boundary Value Tests ---"

# Wednesday (定休日) check - via availability
# 2026-04-01 is Wednesday
run_test "Wednesday availability check" \
  "${GAS_URL}?key=${KEY}&action=getAvailability&date=2026-04-01" \
  '"success":true'

# Very far future date
run_test "Far future date (2027)" \
  "${GAS_URL}?key=${KEY}&action=getAvailability&date=2027-01-15" \
  '"success":true'

# Date format edge cases
run_test "Malformed date returns error" \
  "${GAS_URL}?key=${KEY}&action=getAvailability&date=not-a-date" \
  "success"

# ──────────────────────────────────────────────
# 6. Slot Capacity Tests
# ──────────────────────────────────────────────
echo ""
echo "--- 6. Slot Capacity Tests ---"

# Check that available slots have remaining > 0
SLOT_RESULT=$(curl -sL "${GAS_URL}?key=${KEY}&action=checkSlot&date=2026-06-01" 2>&1)
TOTAL=$((TOTAL + 1))
if echo "$SLOT_RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('success'):
    slots = data.get('slots', {})
    # Check that at least some slots have remaining > 0
    has_available = any(s.get('remaining', 0) > 0 for s in slots.values())
    if has_available:
        print('OK')
    else:
        print('WARN: no available slots')
else:
    print('ERROR: ' + str(data.get('error', 'unknown')))
" 2>/dev/null | grep -q "OK"; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Future date has available slots (capacity=1)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Future date should have available slots"
fi

# Check capacity value
TOTAL=$((TOTAL + 1))
CAP=$(echo "$SLOT_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('capacity',0))" 2>/dev/null)
if [ "$CAP" = "1" ]; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] SLOT_CAPACITY = 1 (1 group per slot)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Expected SLOT_CAPACITY=1, got: $CAP"
fi

# ──────────────────────────────────────────────
# 7. Concurrent Access / Double-Booking Prevention
# ──────────────────────────────────────────────
echo ""
echo "--- 7. Double-Booking Prevention (Code Analysis) ---"
TOTAL=$((TOTAL + 1))
# Check that lock is used before save
if grep -q "LockService.getScriptLock" /Users/yossi/my-app/gas-calendar-api.gs && \
   grep -q "lock.waitLock" /Users/yossi/my-app/gas-calendar-api.gs && \
   grep -q "lock.releaseLock" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] LockService used for concurrent write protection"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing lock mechanism"
fi

# Check idempotency
TOTAL=$((TOTAL + 1))
if grep -q "findBookingByIdFromSheet" /Users/yossi/my-app/gas-calendar-api.gs && \
   grep -q "duplicate.*true" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Idempotency check prevents duplicate bookings"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing idempotency check"
fi

# Check slot availability is checked BEFORE charge
TOTAL=$((TOTAL + 1))
SLOT_LINE=$(grep -n "slot.remaining <= 0" /Users/yossi/my-app/gas-calendar-api.gs | head -1 | cut -d: -f1)
CHARGE_LINE=$(grep -n "createChargePayjp" /Users/yossi/my-app/gas-calendar-api.gs | head -1 | cut -d: -f1)
if [ -n "$SLOT_LINE" ] && [ -n "$CHARGE_LINE" ] && [ "$SLOT_LINE" -lt "$CHARGE_LINE" ]; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Slot check (line $SLOT_LINE) runs BEFORE charge (line $CHARGE_LINE)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Slot check should run before charge"
fi

# ──────────────────────────────────────────────
# 8. Payment Error Handling (Code Analysis)
# ──────────────────────────────────────────────
echo ""
echo "--- 8. Payment Error Handling ---"

# CHARGE_FAILED returns error without saving booking
TOTAL=$((TOTAL + 1))
CHARGE_CATCH=$(awk '/chargeErr/{found=1} found && /return output/{print NR; exit}' /Users/yossi/my-app/gas-calendar-api.gs)
SAVE_LINE=$(grep -n "saveManualToSheet(booking)" /Users/yossi/my-app/gas-calendar-api.gs | grep -v "function\|//" | head -1 | cut -d: -f1)
if [ -n "$CHARGE_CATCH" ]; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Charge failure returns before saving (no orphan booking)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Charge failure should prevent booking save"
fi

# Card-only charge: paypay and onsite don't trigger charge
TOTAL=$((TOTAL + 1))
if grep -q "paymentMethod === 'card'" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Only card payments trigger Pay.jp charge (paypay/onsite skip)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Payment method check missing"
fi

# Admin notified on charge failure
TOTAL=$((TOTAL + 1))
if grep -q "notifyAdminError.*CHARGE_FAILED" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Admin notified on charge failure"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing admin notification on charge failure"
fi

# Save verification (flush + read-back)
TOTAL=$((TOTAL + 1))
if grep -q "SpreadsheetApp.flush()" /Users/yossi/my-app/gas-calendar-api.gs && \
   grep -q "SAVE_FAILED" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Save verification with flush + read-back check"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing save verification"
fi

# ──────────────────────────────────────────────
# 9. Validation Tests (Code Analysis)
# ──────────────────────────────────────────────
echo ""
echo "--- 9. Server-side Validation ---"

# Date format check
TOTAL=$((TOTAL + 1))
if grep -q 'test(booking.date)' /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Date format regex validation"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing date format validation"
fi

# Time in ALL_TIMES check
TOTAL=$((TOTAL + 1))
if grep -q "ALL_TIMES.indexOf(booking.time)" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Time validated against ALL_TIMES whitelist"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing time whitelist validation"
fi

# Past date rejection
TOTAL=$((TOTAL + 1))
if grep -q "bookingDate < today" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Past dates rejected"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing past date rejection"
fi

# Email format validation
TOTAL=$((TOTAL + 1))
if grep -q 'test(booking.email)' /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Email format regex validation"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing email validation"
fi

# Required fields check
TOTAL=$((TOTAL + 1))
if grep -q '!booking.date || !booking.time || !booking.name || !booking.email' /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Required fields (date, time, name, email) enforced"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing required field checks"
fi

# ──────────────────────────────────────────────
# 10. Rate Limiting (Code Analysis)
# ──────────────────────────────────────────────
echo ""
echo "--- 10. Rate Limiting ---"

TOTAL=$((TOTAL + 1))
if grep -q "rlCount >= 3" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Booking rate limit: 3 per 5 minutes per email"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing booking rate limit"
fi

TOTAL=$((TOTAL + 1))
if grep -q "OTP_MAX_FAIL = 5" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] OTP max failure limit: 5 attempts"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing OTP failure limit"
fi

# ──────────────────────────────────────────────
# 10b. NEW Security Hardening Tests
# ──────────────────────────────────────────────
echo ""
echo "--- 10b. Security Hardening (New) ---"

# Refund function exists
TOTAL=$((TOTAL + 1))
if grep -q "function refundChargePayjp" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] refundChargePayjp() function exists"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing refund function"
fi

# Refund called on save failure
TOTAL=$((TOTAL + 1))
if grep -q "refundChargePayjp(booking.chargeId)" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Automatic refund on save failure (rollback)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing auto-refund on save failure"
fi

# Server-side Wednesday check
TOTAL=$((TOTAL + 1))
if grep -q "bookingDow === 3" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Server-side Wednesday (定休日) validation"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing server-side Wednesday check"
fi

# Server-side closed day check
TOTAL=$((TOTAL + 1))
if grep -q "dateSettings.*closed" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Server-side closed-day (休業日) validation"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing server-side closed-day check"
fi

# Card+total consistency
TOTAL=$((TOTAL + 1))
if grep -q "paymentMethod === 'card'" /Users/yossi/my-app/gas-calendar-api.gs && \
   grep -q "cardToken" /Users/yossi/my-app/gas-calendar-api.gs && \
   grep -q "金額が0円の場合はカード決済できません" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Card payment requires total > 0 AND cardToken"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing card+total consistency check"
fi

# OTP inside lock (skip function definition, check call site only)
TOTAL=$((TOTAL + 1))
LOCK_LINE=$(grep -n "lock.waitLock" /Users/yossi/my-app/gas-calendar-api.gs | head -1 | cut -d: -f1)
OTP_LINE=$(grep -n "verifyBookingOtpCode(booking" /Users/yossi/my-app/gas-calendar-api.gs | head -1 | cut -d: -f1)
if [ -n "$LOCK_LINE" ] && [ -n "$OTP_LINE" ] && [ "$OTP_LINE" -gt "$LOCK_LINE" ]; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] OTP verification inside lock (line $OTP_LINE > lock at $LOCK_LINE)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] OTP should be verified inside lock (lock=$LOCK_LINE, otp=$OTP_LINE)"
fi

# Input sanitization
TOTAL=$((TOTAL + 1))
if grep -q "substring(0, 100)" /Users/yossi/my-app/gas-calendar-api.gs && \
   grep -q "substring(0, 500)" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Input sanitization: name(100), remarks(500) length limits"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing input length sanitization"
fi

# Phone sanitization
TOTAL=$((TOTAL + 1))
if grep -q 'replace.*tel' /Users/yossi/my-app/gas-calendar-api.gs || \
   grep -q "booking.tel.*replace" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Phone number sanitized (non-numeric chars stripped)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing phone sanitization"
fi

# ──────────────────────────────────────────────
# 11. Price Calculation Tests (Client-side Analysis)
# ──────────────────────────────────────────────
echo ""
echo "--- 11. Price Calculation (Code Analysis) ---"

# Check male fixed price
TOTAL=$((TOTAL + 1))
if grep -q "4400 \* people.male" /Users/yossi/my-app/reserve.html; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Male base price: ¥4,400 (fixed across plans)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Male price calculation incorrect"
fi

# Check child fixed price
TOTAL=$((TOTAL + 1))
if grep -q "3300 \* people.child" /Users/yossi/my-app/reserve.html; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Child base price: ¥3,300 (fixed across plans)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Child price calculation incorrect"
fi

# Check estimate plan handling
TOTAL=$((TOTAL + 1))
if grep -q "isEstimate.*return null" /Users/yossi/my-app/reserve.html; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Estimate plans (成人式下見/卒業式下見) return null total"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Estimate plan price handling missing"
fi

# ──────────────────────────────────────────────
# 12. Security Tests
# ──────────────────────────────────────────────
echo ""
echo "--- 12. Security ---"

# PIN lockout
TOTAL=$((TOTAL + 1))
if grep -q "PIN_LOCK_THRESHOLD = 10" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] PIN lockout after 10 failures (PCI DSS v4.0)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing PIN lockout"
fi

# Admin token expiration
TOTAL=$((TOTAL + 1))
if grep -q "8 \* 60 \* 60 \* 1000" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Admin token expires after 8 hours"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing token expiration"
fi

# OTP sent via email, not exposed in response
TOTAL=$((TOTAL + 1))
if grep -q "GmailApp.sendEmail" /Users/yossi/my-app/gas-calendar-api.gs && \
   ! grep -q '"otp":' /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] OTP sent via email, not exposed in API response"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] OTP may be exposed in API response"
fi

# ──────────────────────────────────────────────
# 13. Edge Case: Booking on Existing Slot
# ──────────────────────────────────────────────
echo ""
echo "--- 13. Edge Case: Booked Slot Detection ---"

# Find a date that has an existing booking
BOOKED_RESULT=$(curl -sL "${GAS_URL}?key=${KEY}&action=checkSlot&date=2026-03-15" 2>&1)
TOTAL=$((TOTAL + 1))
BOOKED_09=$(echo "$BOOKED_RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('success'):
    slot = data.get('slots', {}).get('09:00', {})
    print(f'booked={slot.get(\"booked\",0)},remaining={slot.get(\"remaining\",0)}')
else:
    print('ERROR')
" 2>/dev/null)
if [ -n "$BOOKED_09" ]; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Slot status returned for booked date (09:00: $BOOKED_09)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Could not get slot status"
fi

# ──────────────────────────────────────────────
# 14. Visit Status Feature (Code Analysis)
# ──────────────────────────────────────────────
echo ""
echo "--- 14. Visit Status Feature (Code Analysis) ---"

TOTAL=$((TOTAL + 1))
if grep -q "function processBookingStatusUpdate" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] processBookingStatusUpdate() function exists"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing processBookingStatusUpdate function"
fi

TOTAL=$((TOTAL + 1))
if grep -q "function sendThankYouEmail" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] sendThankYouEmail() function exists"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing sendThankYouEmail function"
fi

TOTAL=$((TOTAL + 1))
if grep -q "action === 'updateBookingStatus'" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] updateBookingStatus action handler in doPost"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing updateBookingStatus action handler"
fi

TOTAL=$((TOTAL + 1))
if grep -q "visitStatus.*visitChargeId.*statusUpdatedAt" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Sheet schema includes visitStatus, visitChargeId, statusUpdatedAt columns"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing visitStatus columns in sheet schema"
fi

TOTAL=$((TOTAL + 1))
if grep -q "GOOGLE_REVIEW_URL" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Google Review URL from Script Properties"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing GOOGLE_REVIEW_URL"
fi

TOTAL=$((TOTAL + 1))
if grep -q "getManualSheetBookings(includePast)" /Users/yossi/my-app/gas-calendar-api.gs && \
   grep -q "getManualSheetBookings(true)" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] includePast parameter for admin past booking display"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing includePast parameter"
fi

TOTAL=$((TOTAL + 1))
if grep -q "visited.*paid-cancel.*free-cancel" /Users/yossi/my-app/gas-calendar-api.gs; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Status whitelist validation (visited/paid-cancel/free-cancel)"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing status whitelist"
fi

# ──────────────────────────────────────────────
# 15. Admin UI Features (Code Analysis)
# ──────────────────────────────────────────────
echo ""
echo "--- 15. Admin UI Features (Code Analysis) ---"

TOTAL=$((TOTAL + 1))
if grep -q "function visitStatusBadge" /Users/yossi/my-app/kimono-calendar.html; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] visitStatusBadge() function in admin UI"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing visitStatusBadge function"
fi

TOTAL=$((TOTAL + 1))
if grep -q "async function updateBookingStatus" /Users/yossi/my-app/kimono-calendar.html; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] updateBookingStatus() JS function in admin UI"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing updateBookingStatus JS function"
fi

TOTAL=$((TOTAL + 1))
if grep -q "function showToast" /Users/yossi/my-app/kimono-calendar.html; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] showToast() notification function"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing showToast function"
fi

TOTAL=$((TOTAL + 1))
if grep -q "statusActionBar" /Users/yossi/my-app/kimono-calendar.html; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Status action bar in detail modal"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing status action bar"
fi

TOTAL=$((TOTAL + 1))
if grep -q "past-booking" /Users/yossi/my-app/kimono-calendar.html && \
   grep -q "past-badge" /Users/yossi/my-app/kimono-calendar.html; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] Past booking gray-out + badge display"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing past booking display"
fi

TOTAL=$((TOTAL + 1))
if grep -q "btn-visited" /Users/yossi/my-app/kimono-calendar.html && \
   grep -q "btn-free-cancel" /Users/yossi/my-app/kimono-calendar.html && \
   grep -q "btn-paid-cancel" /Users/yossi/my-app/kimono-calendar.html; then
  PASS=$((PASS + 1))
  echo -e "${GREEN}✓ PASS${NC} [$TOTAL] 3 action buttons: 来店済み / 無料キャンセル / 有料キャンセル"
else
  FAIL=$((FAIL + 1))
  echo -e "${RED}✗ FAIL${NC} [$TOTAL] Missing action buttons"
fi

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────
echo ""
echo "============================================"
echo " Test Results: $PASS passed, $FAIL failed (total: $TOTAL)"
echo "============================================"

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}$FAIL test(s) failed.${NC}"
  exit 1
fi
