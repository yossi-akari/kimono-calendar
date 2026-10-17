// 管理画面の「数分でログアウトされる」不具合の回帰テスト（2026-10-17）。
// 保管庫（Script Properties）の一時的な読み取りエラーで、有効な通行証が「無効」と判定されていた。
// GASのサービスと画面側の通信をスタブに差し替えて node で動かす。
// 実行: node tests/admin-session-auth.test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'gas-calendar-api.gs'), 'utf8');
const CAL = fs.readFileSync(path.join(ROOT, 'kimono-calendar.html'), 'utf8');
const BOOK = fs.readFileSync(path.join(ROOT, 'kimono-booking.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}

const FUTURE = Date.now() + 60 * 60 * 1000;
const ADMIN_TOKEN = 'admin-token-1';
const STAFF_TOKEN = 'staff-token-1';

// GAS環境のスタブ。failTimes 回だけ getProperty が例外を投げる（Google側の一時障害の再現）
function makeGas(failTimes) {
  const store = {
    admin_sessions: JSON.stringify([{ token: ADMIN_TOKEN, expires: FUTURE, deviceId: 'dev1', trusted: true }]),
    staff_sessions: JSON.stringify([{ token: STAFF_TOKEN, expires: FUTURE }]),
  };
  let remainingFailures = failTimes || 0;
  const warns = [];
  const sleeps = [];
  const sandbox = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty(k) {
          if (remainingFailures > 0) { remainingFailures--; throw new Error('Unexpected error while getting the method or property getProperty'); }
          return store[k] === undefined ? null : store[k];
        },
        setProperty(k, v) { store[k] = v; },
        deleteProperty(k) { delete store[k]; },
      }),
    },
    Utilities: { sleep: (ms) => sleeps.push(ms), getUuid: () => 'uuid' },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput() {
        let content = '';
        return { setMimeType() {}, setContent(c) { content = c; }, getContent: () => content };
      },
    },
    Logger: { log() {} },
    console: { log() {}, warn: (m) => warns.push(String(m)), error() {} },
    UrlFetchApp: {}, SpreadsheetApp: {}, CacheService: {}, ScriptApp: {}, MailApp: {}, GmailApp: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'gas.js' });
  // doPost の想定外エラー時のメール通知は止めておく
  sandbox.notifyAdminError = () => {};
  return { gas: sandbox, warns, sleeps };
}

// doPost を呼んで JSON 応答を返す。'noSuchAction' は認証を通過すると 'Unknown action' になる
function post(gas, body) {
  const out = gas.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.getContent());
}

console.log('\n[1] サーバー: 平常時の判定は従来どおり');
{
  const { gas } = makeGas(0);
  check('管理者トークンは管理者として通る', post(gas, { token: ADMIN_TOKEN, action: 'noSuchAction' }).error === 'Unknown action');
  check('スタッフトークンはスタッフとして通る', post(gas, { token: STAFF_TOKEN, action: 'noSuchAction' }).error === 'Unknown action');
  check('スタッフは管理者専用操作を拒否される', post(gas, { token: STAFF_TOKEN, action: 'getSettings' }).error === 'スタッフモードではこの操作はできません');
  check('存在しないトークンは Unauthorized', post(gas, { token: 'nope', action: 'noSuchAction' }).error === 'Unauthorized');
  check('トークン無しは Unauthorized', post(gas, { action: 'noSuchAction' }).error === 'Unauthorized');
  check('互換関数 isValidAdminToken は true/false を返す', gas.isValidAdminToken(ADMIN_TOKEN) === true && gas.isValidAdminToken('nope') === false);
  check('互換関数 isValidStaffToken は true/false を返す', gas.isValidStaffToken(STAFF_TOKEN) === true && gas.isValidStaffToken('nope') === false);
}

console.log('\n[2] サーバー: 保管庫の読み取りが一時的に失敗しても、やり直しで通る');
{
  const { gas, sleeps } = makeGas(2);
  const r = post(gas, { token: ADMIN_TOKEN, action: 'noSuchAction' });
  check('2回失敗→3回目成功で管理者として通る（以前はここで Unauthorized）', r.error === 'Unknown action', JSON.stringify(r));
  check('やり直しの間に待ち時間を入れている', sleeps.length === 2, JSON.stringify(sleeps));
}
{
  const { gas } = makeGas(2);
  // 管理者側の確認(成功するまで3回)を通過した後、スタッフ側は1回目で読める
  const r = post(gas, { token: STAFF_TOKEN, action: 'noSuchAction' });
  check('スタッフも一時失敗をやり直しで通る', r.error === 'Unknown action', JSON.stringify(r));
}

console.log('\n[3] サーバー: 読み取りが続けて失敗したら「無効」ではなく「確認できなかった」と返す');
{
  const { gas, warns } = makeGas(100);
  const r = post(gas, { token: ADMIN_TOKEN, action: 'getBookings' });
  check('AUTH_CHECK_FAILED を返す（Unauthorized ではない）', r.success === false && r.error === 'AUTH_CHECK_FAILED', JSON.stringify(r));
  check('理由を実行ログに残す', warns.some(w => w.includes('理由=error')), warns.join(' | '));
  check('ログにトークン本体を出さない', !warns.some(w => w.includes(ADMIN_TOKEN)));
}
{
  const { gas, warns } = makeGas(0);
  post(gas, { token: 'nope', action: 'getBookings' });
  check('本当に無効なときも理由（notfound）をログに残す', warns.some(w => w.includes('理由=notfound')), warns.join(' | '));
}

// ── 画面側: 関数を HTML から取り出して動かす ─────────────────────
function extract(html, startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  const e = html.indexOf(endMarker, s);
  if (s === -1 || e === -1) throw new Error('抽出失敗: ' + startMarker);
  return html.substring(s, e);
}

// kimono-calendar.html の adminPost。responses を順に返す gasPost スタブで動かす
function makeCalendar(responses) {
  const code = extract(CAL, 'const UNAUTHORIZED_RECHECK_WAIT_MS', '// ── スタッフモードUI制御');
  const calls = [];
  const sandbox = {
    localStorage: { getItem: () => 'tok' },
    setTimeout: (fn) => fn(),
    gasPost: async (body) => { calls.push(body); const r = responses.shift(); if (r instanceof Error) throw r; return r; },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { adminPost: sandbox.adminPost, calls };
}

console.log('\n[4] カレンダー画面: 「無効」と言われたら1回だけ聞き直す');
(async () => {
  {
    const { adminPost, calls } = makeCalendar([{ success: false, error: 'Unauthorized' }, { success: true, bookings: [] }]);
    const r = await adminPost({ action: 'getBookings' });
    check('1回目 Unauthorized → 聞き直して成功ならログアウトしない', r.success === true && calls.length === 2);
  }
  {
    const { adminPost, calls } = makeCalendar([{ success: false, error: 'Unauthorized' }, { success: false, error: 'Unauthorized' }]);
    const r = await adminPost({ action: 'getBookings' });
    check('2回続けて Unauthorized なら Unauthorized を返す（従来どおりログアウト）', r.error === 'Unauthorized' && calls.length === 2);
  }
  {
    const { adminPost, calls } = makeCalendar([{ success: false, error: 'AUTH_CHECK_FAILED' }]);
    const r = await adminPost({ action: 'getBookings' });
    check('AUTH_CHECK_FAILED はログアウト扱いにしない', r.success === false && r.error !== 'Unauthorized' && calls.length === 1, JSON.stringify(r));
  }
  {
    const { adminPost, calls } = makeCalendar([{ success: true }]);
    await adminPost({ action: 'getBookings' });
    check('成功時は1回しか送らない', calls.length === 1);
    check('トークンを付けて送る', calls[0].token === 'tok' && calls[0].action === 'getBookings');
  }
  {
    const { adminPost } = makeCalendar([new Error('GAS応答がJSON形式ではありません')]);
    const r = await adminPost({ action: 'getBookings' });
    check('通信エラーは success:false にそろえる（例外を投げない）', r.success === false && /JSON/.test(r.error));
  }

  // kimono-booking.html の postToGAS。fetch と location.reload をスタブにする
  function makeBooking(responses) {
    const code = extract(BOOK, 'const UNAUTHORIZED_RECHECK_WAIT_MS', '// ── Enterキー無効化');
    const state = { fetches: 0, reloaded: false, removed: false };
    const sandbox = {
      GAS_URL: 'https://example.invalid/exec',
      localStorage: { getItem: () => 'tok', removeItem: () => { state.removed = true; } },
      location: { reload: () => { state.reloaded = true; } },
      setTimeout: (fn) => fn(),
      fetch: async () => { state.fetches++; const r = responses.shift(); return { json: async () => r }; },
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { postToGAS: sandbox.postToGAS, state };
  }

  console.log('\n[5] 予約入力画面: 同じく1回だけ聞き直す');
  {
    const { postToGAS, state } = makeBooking([{ success: false, error: 'Unauthorized' }, { success: true }]);
    const r = await postToGAS('getBookings', {});
    check('1回目 Unauthorized → 聞き直して成功なら再読み込みしない', r.success === true && !state.reloaded && !state.removed && state.fetches === 2);
  }
  {
    const { postToGAS, state } = makeBooking([{ success: false, error: 'Unauthorized' }, { success: false, error: 'Unauthorized' }]);
    await postToGAS('getBookings', {});
    check('2回続けて Unauthorized ならトークンを消して再読み込み', state.reloaded && state.removed);
  }
  {
    const { postToGAS, state } = makeBooking([{ success: false, error: 'AUTH_CHECK_FAILED' }]);
    let threw = false;
    try { await postToGAS('saveManual', {}); } catch (e) { threw = true; }
    check('AUTH_CHECK_FAILED は通信エラー扱い（例外）にし、ログアウトしない', threw && !state.reloaded && !state.removed);
  }

  console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
  process.exit(fail ? 1 : 0);
})();
