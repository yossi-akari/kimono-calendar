// AJ（アクティビティジャパン）取り込み停止スイッチのテスト。
// GASのサービスをスタブに差し替えて node で動かす。
// 実行: node tests/aj-import-switch.test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'gas-calendar-api.gs'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}

// Gmail検索の呼び出しを記録するスタブ環境。enabled で AJ_IMPORT_ENABLED を差し替える
function makeGas(enabled) {
  const searches = [];
  const logs = [];
  // 検索クエリごとに返すメール（じゃらんのキャンセル1件・AJのキャンセル1件）
  const mails = {
    'from:reservation_cancel@activityboard.jp': ['予約番号：JR001\nキャンセルされました'],
    'from:activity-japan@activityjapan.com':     ['予約番号：2604165834724\nキャンセル手続が完了'],
  };
  const sandbox = {
    GmailApp: {
      search(q) {
        searches.push(q);
        return (mails[q] || []).map(body => ({ getMessages: () => [{ getPlainBody: () => body, getDate: () => new Date() }] }));
      },
    },
    Utilities: { formatDate: () => '2026-10-17' },
    Logger: { log: (m) => logs.push(String(m)) },
    PropertiesService: {}, UrlFetchApp: {}, SpreadsheetApp: {}, CacheService: {}, ScriptApp: {}, MailApp: {},
    console,
  };
  const src = enabled ? SRC.replace('const AJ_IMPORT_ENABLED = false;', 'const AJ_IMPORT_ENABLED = true;') : SRC;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'gas.js' });
  return { gas: sandbox, searches, logs };
}

console.log('\n[1] 停止中（現在の設定）');
{
  check('スイッチは false（停止）になっている', /const AJ_IMPORT_ENABLED = false;/.test(SRC));
  const { gas, searches, logs } = makeGas(false);
  const r = gas.getActivityJapanBookings();
  check('AJ予約は0件を返す', Array.isArray(r) && r.length === 0);
  check('AJのメールを一切検索しない', !searches.some(q => q.includes('activityjapan')), searches.join(' | '));
  check('停止中であることをログに出す', logs.some(l => l.includes('取り込み停止中')));
  check('「AJ変更メール…見つかりません」のログが出ない', !logs.some(l => l.includes('AJ変更メール')));
}
{
  const { gas, searches } = makeGas(false);
  const ids = gas.getCancelledIds();
  check('じゃらんのキャンセル確認は続ける', ids.has('JR001'));
  check('AJのキャンセルメールは検索しない', !searches.some(q => q.includes('activityjapan')), searches.join(' | '));
  check('AJの予約番号はキャンセル一覧に入らない', !ids.has('2604165834724'));
}

console.log('\n[2] 再開した場合（true に戻したとき）');
{
  const { gas, searches } = makeGas(true);
  gas.getActivityJapanBookings();
  check('AJの確定メールを検索する', searches.includes('from:reserve-system@activityjapan.com'));
  const ids = gas.getCancelledIds();
  check('AJのキャンセルも従来どおり拾う', ids.has('2604165834724') && ids.has('JR001'));
}

console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
