// 週次サマリーの「確認推奨：現地決済の予約」欄のテスト。
// GASのサービスをスタブに差し替えて node で動かす。
// 実行: node tests/weekly-onsite-review.test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'gas-calendar-api.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'reserve.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}

// GASを読み込み、週次サマリーが使うデータ取得関数だけ差し替える
function makeGas({ webBookings = [], cancelled = [], supabaseThrows = false } = {}) {
  const mails = [];
  const sandbox = {
    UrlFetchApp: {}, SpreadsheetApp: {}, CacheService: {}, ScriptApp: {}, MailApp: {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Utilities: { formatDate: () => '2026-10-19' },
    GmailApp: { sendEmail: (to, subj, body) => mails.push({ to, subj, body }) },
    Logger: { log: () => {} },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'gas.js' });
  sandbox.getCachedBookings = () => [];
  sandbox.getRawBookings = () => [];
  sandbox.getCancelledIds = () => new Set(cancelled);
  sandbox.getWebBookingsFromSupabase = () => {
    if (supabaseThrows) throw new Error('Supabase停止');
    return webBookings;
  };
  sandbox.getAdminEmail = () => 'admin@example.test';
  return { gas: sandbox, mails };
}

// テスト用の予約1件を作る
function bk(over) {
  return Object.assign({
    reservationId: 'HP-1', date: '2026-10-23', time: '10:00', name: '山田 花子',
    tel: '090-1234-5678', plan: 'ベーシック', total: 2970,
    payment: '現地決済（現金）', visitStatus: 'confirmed', channel: 'ウェブサイト',
  }, over);
}

// ── 1. 電話番号の判定がブラウザ側と揃っているか ─────────────
console.log('\n[1] isJapanesePhone が reserve.html と同じ判定');
{
  const { gas } = makeGas();
  const start = HTML.indexOf('function isJapanesePhone(');
  const code = HTML.slice(start, HTML.indexOf('\n}\n', start) + 2);
  const client = {};
  vm.runInNewContext(code + '\nout.f = isJapanesePhone;', { out: client, String });
  const samples = ['090-1234-5678', '076-201-8119', '+81 90-1234-5678', '9753012345',
                   '+1 415-555-0123', '010-1-415-555-0123', '0912-345-678', '', '090-1234'];
  const diff = samples.filter(t => gas.isJapanesePhone(t) !== client.f(t));
  check('サンプル9件で GAS とブラウザの判定が一致', diff.length === 0, '不一致: ' + diff.join(', '));
}

// ── 2. 海外の現地表記の可能性 ───────────────────────────
console.log('\n[2] isPossiblyForeignLocalPhone');
{
  const { gas } = makeGas();
  const cases = [
    ['090-1234-5678', false, '日本の携帯'],
    ['050-1234-5678', false, '日本のIP電話'],
    ['0800-123-4567', false, '日本のフリーダイヤル(0800)'],
    ['076-201-8119',  false, '金沢の固定電話'],
    ['03-1234-5678',  false, '東京の固定電話'],
    ['0912-345-678',  true,  '台湾の携帯（福岡等の固定電話と同じ形）'],
    ['0905-123-456',  true,  '10桁の090始まり（日本の携帯は11桁）'],
    ['07700 900123',  true,  'イギリスの携帯'],
    ['0917 123 4567', true,  'フィリピンの携帯'],
    ['+81 90-1234-5678', false, '国際表記は対象外'],
  ];
  for (const [tel, expected, label] of cases) {
    check(`${label} ${tel} → ${expected}`, gas.isPossiblyForeignLocalPhone(tel) === expected);
  }
}

// ── 3. 要確認欄の中身 ─────────────────────────────────
console.log('\n[3] buildOnsiteReviewSection');
{
  const { gas } = makeGas();
  const rows = [
    bk({ reservationId: 'HP-jp' }),                                         // 普通の日本人 → 出さない
    bk({ reservationId: 'HP-ou', name: '王 偉超', tel: '9753012345', total: 47520, plan: '撮影付き' }),
    bk({ reservationId: 'HP-latin', name: 'Smith John' }),
    bk({ reservationId: 'HP-tw', name: '林 美玲', tel: '0912-345-678' }),
    bk({ reservationId: 'HP-card', name: 'Brown Amy', tel: '+1 415 555 0123', payment: '事前決済（クレジットカード）' }),
    bk({ reservationId: 'HP-cxl', name: 'Lee Tom', visitStatus: 'free-cancel' }),
    bk({ reservationId: 'HP-gone', name: 'Kim Ann' }),
    bk({ reservationId: 'HP-est', name: 'Tanaka Y', payment: '未定' }),
  ];
  const text = gas.buildOnsiteReviewSection(rows, new Set(['HP-gone'])).join('\n');
  check('見出しが入る', text.includes('■ 確認推奨：現地決済の予約'));
  check('海外番号の王様（10/16と同じ形）が載る', text.includes('HP-ou') && text.includes('電話番号が日本の形ではない'));
  check('金額がカンマ区切り', text.includes('¥47,520'));
  check('ローマ字名が載る', text.includes('HP-latin') && text.includes('名前がローマ字'));
  check('台湾の携帯の形が載る', text.includes('HP-tw') && text.includes('海外の番号かもしれない'));
  check('普通の日本人の予約は載らない', !text.includes('HP-jp'));
  check('カード決済は載らない', !text.includes('HP-card'));
  check('無料キャンセル済みは載らない', !text.includes('HP-cxl'));
  check('キャンセル一覧にある予約は載らない', !text.includes('HP-gone'));
  check('見積もり（未定）は載らない', !text.includes('HP-est'));
  check('該当0件なら欄ごと出さない', gas.buildOnsiteReviewSection([bk({})], new Set()).length === 0);
}

// ── 4. 週次メール全体 ─────────────────────────────────
console.log('\n[4] weeklyBookingSummary のメール');
{
  const { gas, mails } = makeGas({ webBookings: [bk({ reservationId: 'HP-ou', name: '王 偉超', tel: '9753012345' })] });
  gas.weeklyBookingSummary();
  const body = mails[0] ? mails[0].body : '';
  check('メールが1通送られる', mails.length === 1, mails.length + '通');
  check('要確認欄が入る', body.includes('■ 確認推奨：現地決済の予約') && body.includes('HP-ou'));
  check('欄はWEB予約件数と状態確認の間', body.indexOf('■ WEB予約件数') < body.indexOf('■ 確認推奨') &&
        body.indexOf('■ 確認推奨') < body.indexOf('■ 状態確認'));
  check('末尾の注意書きも残っている', body.includes('※ このメールは情報提供です。'));
}
{
  const { gas, mails } = makeGas({ webBookings: [bk({})] });
  gas.weeklyBookingSummary();
  check('該当なしなら要確認欄は出ない', mails.length === 1 && !mails[0].body.includes('確認推奨'));
}
{
  const { gas, mails } = makeGas({ supabaseThrows: true });
  gas.weeklyBookingSummary();
  const body = mails[0] ? mails[0].body : '';
  check('Supabase取得が失敗してもサマリーは送る', mails.length === 1 && !mails[0].subj.includes('ALERT'));
  check('失敗したことは本文に書く', body.includes('集計に失敗しました'));
}

console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
