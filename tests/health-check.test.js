// dailyHealthCheck のリトライ と Supabase監視 のテスト。
// GASのサービス（UrlFetchApp等）をスタブに差し替えて node で動かす。
const fs = require('fs');
const vm = require('vm');

const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'gas-calendar-api.gs'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}

// 指定した応答列を順に返すスタブ環境を作る
function makeSandbox({ responses, props }) {
  const alerts = [];
  const fetched = [];
  let slept = 0;
  const queue = responses.slice();

  const sandbox = {
    UrlFetchApp: {
      fetch(url, opts) {
        fetched.push({ url, opts });
        const r = queue.shift();
        if (!r) throw new Error('スタブ応答が足りない');
        if (r.throw) throw new Error(r.throw);
        return { getResponseCode: () => r.code, getContentText: () => r.body };
      }
    },
    Utilities: {
      formatDate: () => '2026-09-10',
      sleep: (ms) => { slept += ms; }
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => (props || {})[k] || null })
    },
    GmailApp: { sendEmail: (to, subj, body) => alerts.push({ to, subj, body }) },
    Logger: { log: () => {} },
    SpreadsheetApp: {}, CacheService: {}, ScriptApp: {}, MailApp: {},
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'gas.js' });
  return { sandbox, alerts, fetched, sleptMs: () => slept };
}

const OK_SLOT   = JSON.stringify({ success: true, slots: { '09:00': { booked: 0 } } });
const OK_CONFIG = JSON.stringify({ success: true, plans: [] });
const G404      = '<!DOCTYPE html><html lang="en"><head><script>window[\'ppConfig\']…';

console.log('\n── fetchForHealthCheck: リトライ挙動 ──');
{
  // 8/6に起きたシナリオの再現: 1回目404 → 2回目200
  const t = makeSandbox({ responses: [{ code: 404, body: G404 }, { code: 200, body: OK_SLOT }], props: {} });
  const r = t.sandbox.fetchForHealthCheck('https://example.test/exec');
  check('1回目404 → 2回目200 で ok=true', r.ok === true, 'ok=' + r.ok);
  check('tries=2 を記録', r.tries === 2, 'tries=' + r.tries);
  check('リトライ間隔をsleepしている', t.sleptMs() === 3000, 'slept=' + t.sleptMs());
}
{
  const t = makeSandbox({ responses: [{ code: 404, body: G404 }, { code: 404, body: G404 }, { code: 404, body: G404 }], props: {} });
  const r = t.sandbox.fetchForHealthCheck('https://example.test/exec');
  check('3回連続404 で ok=false', r.ok === false);
  check('4回目は叩かない（最大3回）', t.fetched.length === 3, 'fetch回数=' + t.fetched.length);
}
{
  const t = makeSandbox({ responses: [{ throw: 'DNS死亡' }, { code: 200, body: OK_SLOT }], props: {} });
  const r = t.sandbox.fetchForHealthCheck('https://example.test/exec');
  check('例外のあとに成功しても ok=true', r.ok === true && r.tries === 2);
}

console.log('\n── checkGasCheckSlot: アラート判定 ──');
{
  // ★回帰テスト: 修正前はここでアラートが飛んでいた（8/6の誤報）
  const t = makeSandbox({ responses: [{ code: 404, body: G404 }, { code: 200, body: OK_SLOT }], props: {} });
  t.sandbox.checkGasCheckSlot();
  check('【回帰】404→200の瞬断ではアラートを出さない', t.alerts.length === 0,
        'alerts=' + t.alerts.map(a => a.subj).join(','));
}
{
  const t = makeSandbox({ responses: Array(3).fill({ code: 404, body: G404 }), props: {} });
  t.sandbox.checkGasCheckSlot();
  check('本物の404連続ならアラートを出す', t.alerts.length === 1, 'alerts=' + t.alerts.length);
  check('件名にHTTP 404が入る', /HTTP 404/.test(t.alerts[0].subj), t.alerts[0] && t.alerts[0].subj);
  check('本文に試行回数が入る', /3回連続/.test(t.alerts[0].body));
}
{
  const t = makeSandbox({ responses: [{ code: 200, body: JSON.stringify({ success: false, error: 'Unauthorized' }) }], props: {} });
  t.sandbox.checkGasCheckSlot();
  check('success=false はリトライせず即アラート', t.alerts.length === 1 && t.fetched.length === 1);
  check('ACCESS_KEY不一致の件名', /認証\/動作エラー/.test(t.alerts[0].subj), t.alerts[0] && t.alerts[0].subj);
}
{
  const t = makeSandbox({ responses: [{ code: 200, body: 'これはJSONではない' }], props: {} });
  t.sandbox.checkGasCheckSlot();
  check('200でもJSONでなければアラート', t.alerts.length === 1 && /JSON解析失敗/.test(t.alerts[0].subj));
}

console.log('\n── checkSupabaseCustomerApi: お客様経路の監視 ──');
const PROPS = {
  SUPABASE_URL: 'https://ovaauspaumntorumuvrs.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key-dummy',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-dummy'
};
{
  const t = makeSandbox({ responses: [{ code: 200, body: OK_CONFIG }, { code: 200, body: OK_SLOT }], props: PROPS });
  t.sandbox.checkSupabaseCustomerApi();
  check('正常時はアラートなし', t.alerts.length === 0, t.alerts.map(a => a.subj).join(','));
  check('/config と /check-slot の2本を叩く', t.fetched.length === 2, 'fetch回数=' + t.fetched.length);
  check('URLが /functions/v1/config', /\/functions\/v1\/config$/.test(t.fetched[0].url), t.fetched[0].url);
  check('URLが /functions/v1/check-slot', /\/functions\/v1\/check-slot$/.test(t.fetched[1].url), t.fetched[1].url);
  check('★anon keyで叩いている（service_roleではない）',
        t.fetched[0].opts.headers.apikey === 'anon-key-dummy' &&
        t.fetched[0].opts.headers.Authorization === 'Bearer anon-key-dummy',
        JSON.stringify(t.fetched[0].opts.headers));
  check('service_role keyを一切送っていない',
        !JSON.stringify(t.fetched).includes('service-role-dummy'));
  check('check-slotに当日日付を渡す', t.fetched[1].opts.payload === JSON.stringify({ date: '2026-09-10' }),
        t.fetched[1].opts.payload);
  check('POSTで叩く', t.fetched[0].opts.method === 'post');
}
{
  // ★4/18の再現: 再デプロイで verify_jwt が戻り Invalid JWT で全失敗
  const t = makeSandbox({ responses: Array(3).fill({ code: 401, body: '{"message":"Invalid JWT"}' }), props: PROPS });
  t.sandbox.checkSupabaseCustomerApi();
  check('【4/18再現】Invalid JWTでアラートが飛ぶ', t.alerts.length === 1, 'alerts=' + t.alerts.length);
  check('件名にお客様向けAPI不調', /お客様向けAPI不調/.test(t.alerts[0].subj), t.alerts[0] && t.alerts[0].subj);
  check('本文でverify_jwtを疑うよう案内', /verify_jwt/.test(t.alerts[0].body));
}
{
  const t = makeSandbox({ responses: [{ code: 200, body: OK_CONFIG }, { code: 200, body: JSON.stringify({ success: false, error: '水曜日は定休日です' }) }], props: PROPS });
  t.sandbox.checkSupabaseCustomerApi();
  check('check-slotがsuccess=falseならアラート', t.alerts.length === 1 && /エラー応答/.test(t.alerts[0].subj));
  check('エラー内容を本文に載せる', /水曜日は定休日/.test(t.alerts[0].body));
}
{
  const t = makeSandbox({ responses: [], props: { SUPABASE_URL: 'https://x.supabase.co' } });
  t.sandbox.checkSupabaseCustomerApi();
  check('ANON_KEY未設定なら「黙らず」アラート', t.alerts.length === 1 && /無監視状態/.test(t.alerts[0].subj),
        t.alerts.map(a => a.subj).join(','));
  check('未設定時はfetchしない', t.fetched.length === 0);
}
{
  const t = makeSandbox({ responses: [{ code: 200, body: OK_CONFIG }, { code: 200, body: OK_SLOT }],
                          props: Object.assign({}, PROPS, { SUPABASE_URL: 'https://x.supabase.co/' }) });
  t.sandbox.checkSupabaseCustomerApi();
  check('URL末尾スラッシュでも二重スラッシュにならない',
        t.fetched[0].url === 'https://x.supabase.co/functions/v1/config', t.fetched[0].url);
}

console.log('\n── dailyHealthCheck: 2系統が独立して走るか ──');
{
  // GASが3回失敗しても Supabase の確認まで到達すること
  const t = makeSandbox({
    responses: [...Array(3).fill({ code: 500, body: 'err' }), { code: 200, body: OK_CONFIG }, { code: 200, body: OK_SLOT }],
    props: PROPS
  });
  t.sandbox.dailyHealthCheck();
  check('GASが落ちてもSupabase監視は実行される', t.fetched.length === 5, 'fetch回数=' + t.fetched.length);
  check('GAS側のアラートのみ1通', t.alerts.length === 1 && /GAS API不調/.test(t.alerts[0].subj),
        t.alerts.map(a => a.subj).join(','));
}
{
  const t = makeSandbox({
    responses: [{ code: 200, body: OK_SLOT }, ...Array(3).fill({ code: 401, body: 'Invalid JWT' })],
    props: PROPS
  });
  t.sandbox.dailyHealthCheck();
  check('Supabaseが落ちた時はSupabaseのアラートのみ',
        t.alerts.length === 1 && /お客様向けAPI不調/.test(t.alerts[0].subj),
        t.alerts.map(a => a.subj).join(','));
}

console.log('\n========================================');
console.log('  成功 ' + pass + ' / 失敗 ' + fail);
console.log('========================================\n');
process.exit(fail === 0 ? 0 : 1);
