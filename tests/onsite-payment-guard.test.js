// 「海外からの予約は事前カード決済のみ」判定のテスト。
// reserve.html（ブラウザ側）と save-booking/index.ts（サーバー側）から
// 判定関数を取り出して node で動かし、両者の判定が揃っているかも確認する。
// 実行: node tests/onsite-payment-guard.test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'reserve.html'), 'utf8');
const TS   = fs.readFileSync(path.join(ROOT, 'supabase/functions/save-booking/index.ts'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}

// ソースから「function 名前(...) { ... }」を1つ切り出す（行頭の } で終わる前提）
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' が見つからない');
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}

// TypeScript の型注釈を外して JS として実行できる形にする（このテストで使う関数に必要な分だけ）
function stripTypes(code) {
  return code
    .replace(/\(tel: string\): boolean/, '(tel)')
    .replace(/\(booking: Record<string, unknown>\): string \| null/, '(booking)');
}

// ── サーバー側の関数を読み込む ─────────────────────
const server = {};
vm.runInNewContext(
  stripTypes(extractFunction(TS, 'isJapanesePhone')) + '\n' +
  stripTypes(extractFunction(TS, 'getOnsiteBlockReason')) + '\n' +
  'out.isJapanesePhone = isJapanesePhone; out.getOnsiteBlockReason = getOnsiteBlockReason;',
  { out: server, String }
);

// ── ブラウザ側の関数を読み込む（document / navigator はスタブ） ──
function makeClient({ langs = ['ja'], currentLang = 'ja', tel = '', htmlLang, htmlClasses = [], urlLang = null, saved = null } = {}) {
  const out = {};
  const sandbox = {
    out, String, Array, URLSearchParams,
    navigator: { languages: langs, language: langs[0] },
    window: { location: { search: urlLang ? '?lang=' + urlLang : '' } },
    localStorage: { getItem: () => saved },
    document: {
      documentElement: {
        lang: htmlLang === undefined ? (currentLang === 'zh' ? 'zh-TW' : currentLang) : htmlLang,
        classList: { contains: (c) => htmlClasses.includes(c) },
      },
      getElementById: (id) => (id === 'tel' ? { value: tel } : null),
    },
  };
  const names = ['getBrowserLangs', 'isForeignBrowser', 'detectInitialLang',
                 'isJapanesePhone', 'isPageMachineTranslated', 'getOnsiteBlockReason'];
  vm.runInNewContext(
    "const SUPPORTED_LANGS = ['ja', 'en', 'zh']; const LANG_PREF_KEY = 'reserve_lang_v1';\n" +
    'let currentLang = ' + JSON.stringify(currentLang) + ';\n' +
    names.map(n => extractFunction(HTML, n)).join('\n') + '\n' +
    names.map(n => 'out.' + n + ' = ' + n + ';').join(' '),
    sandbox
  );
  return out;
}

// ── 1. 電話番号の判定 ──────────────────────────
console.log('\n[1] 日本の電話番号の判定');
const PHONES = [
  ['090-1234-5678', true],  ['09012345678', true],   ['076-201-8119', true],
  ['0120-123-456', true],   ['050 1234 5678', true], ['+81 90-1234-5678', true],
  ['+81 090-1234-5678', true], ['81-76-201-8119', true], ['+81 (0)90 1234 5678', true],
  ['9753012345', false],    ['+1 415-555-0123', false], ['+86 138 0013 8000', false],
  ['+65 9123 4567', false], ['010-1-415-555-0123', false], ['001-1-415-555-0123', false],
  ['090-1234', false],      ['', false],
];
const client = makeClient();
for (const [tel, expected] of PHONES) {
  const s = server.isJapanesePhone(tel), c = client.isJapanesePhone(tel);
  check(`${JSON.stringify(tel)} → ${expected ? '日本' : '海外/不正'}`, s === expected && c === expected,
        `server=${s} client=${c}`);
}

// ── 2. サーバー側: 現地決済の可否 ──────────────────
console.log('\n[2] save-booking: 現地決済を拒否する条件');
const base = { lang: 'ja', tel: '090-1234-5678', foreignBrowser: false, machineTranslated: false };
check('日本語版・日本の番号 → 受付', server.getOnsiteBlockReason(base) === null);
check('英語版 → 拒否', server.getOnsiteBlockReason({ ...base, lang: 'en' }) === 'lang');
check('ブラウザ言語が海外 → 拒否', server.getOnsiteBlockReason({ ...base, foreignBrowser: true }) === 'browser');
check('自動翻訳中 → 拒否', server.getOnsiteBlockReason({ ...base, machineTranslated: true }) === 'translated');
check('海外の番号（10/16の事例）→ 拒否', server.getOnsiteBlockReason({ ...base, tel: '9753012345' }) === 'tel');
check('旧ページ（lang等なし）・日本の番号 → 受付', server.getOnsiteBlockReason({ tel: '090-1234-5678' }) === null);
check('旧ページ（lang等なし）・海外の番号 → 拒否', server.getOnsiteBlockReason({ tel: '+1 415 555 0123' }) === 'tel');

// ── 3. ブラウザ側: 現地決済の可否 ──────────────────
console.log('\n[3] reserve.html: 現地決済を隠す条件');
check('日本語ブラウザ・日本語版・電話未入力 → 表示', makeClient().getOnsiteBlockReason() === null);
check('日本語ブラウザ・日本の番号 → 表示', makeClient({ tel: '090-1234-5678' }).getOnsiteBlockReason() === null);
check('ブラウザに日本語あり（en-US, ja）→ 表示', makeClient({ langs: ['en-US', 'ja'] }).getOnsiteBlockReason() === null);
check('英語版で閲覧 → 隠す', makeClient({ currentLang: 'en', langs: ['en-US'] }).getOnsiteBlockReason() === 'lang');
check('英語ブラウザで日本語版 → 隠す', makeClient({ langs: ['en-US', 'en'] }).getOnsiteBlockReason() === 'browser');
check('Chrome自動翻訳中（class）→ 隠す', makeClient({ htmlClasses: ['translated-ltr'] }).getOnsiteBlockReason() === 'translated');
check('Chrome自動翻訳中（lang書換）→ 隠す', makeClient({ htmlLang: 'en' }).getOnsiteBlockReason() === 'translated');
check('海外の番号 → 隠す', makeClient({ tel: '+65 9123 4567' }).getOnsiteBlockReason() === 'tel');
check('中国語版の lang=zh-TW は翻訳扱いしない',
      makeClient({ currentLang: 'zh', langs: ['zh-TW'] }).isPageMachineTranslated() === false);

// ── 4. 表示言語の初期判定 ──────────────────────────
console.log('\n[4] reserve.html: ページを開いたときの言語');
check('日本語ブラウザ → 日本語', makeClient({ langs: ['ja-JP'] }).detectInitialLang() === 'ja');
check('英語ブラウザ → 英語', makeClient({ langs: ['en-US'] }).detectInitialLang() === 'en');
check('中国語（簡体）ブラウザ → 繁中', makeClient({ langs: ['zh-CN'] }).detectInitialLang() === 'zh');
check('韓国語ブラウザ → 英語', makeClient({ langs: ['ko-KR'] }).detectInitialLang() === 'en');
check('言語ボタンで日本語を選んだ人 → 日本語', makeClient({ langs: ['en-US'], saved: 'ja' }).detectInitialLang() === 'ja');
check('URL ?lang=zh が最優先', makeClient({ langs: ['ja'], saved: 'en', urlLang: 'zh' }).detectInitialLang() === 'zh');
check('URL ?lang= が不正値なら無視', makeClient({ langs: ['ja'], urlLang: 'fr' }).detectInitialLang() === 'ja');

// ── 5. 組み込み確認 ───────────────────────────────
console.log('\n[5] 組み込み確認');
check('save-booking が ONSITE_NOT_ALLOWED を返す', TS.includes("'ONSITE_NOT_ALLOWED'"));
check('save-booking は見積もりプランを対象外にしている', /paymentMethod !== 'card' && !amountCheck\.isEstimate/.test(TS));
check('reserve.html が ONSITE_NOT_ALLOWED を処理する', HTML.includes("json.error === 'ONSITE_NOT_ALLOWED'"));
check('reserve.html が判定材料を送信する', /foreignBrowser: isForeignBrowser\(\), machineTranslated: isPageMachineTranslated\(\)/.test(HTML));
for (const key of ['onsiteUnavailableNote', 'alertOnsiteUnavailable']) {
  const n = (HTML.match(new RegExp('^\\s+' + key + ':', 'gm')) || []).length;
  check(`翻訳キー ${key} が3言語分ある`, n === 3, `${n}件`);
}

console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
process.exit(fail ? 1 : 0);
