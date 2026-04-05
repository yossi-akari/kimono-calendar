#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""予約システム 運用・引き渡しガイド PDF
フォント戦略:
  - Helvetica      … ラテン文字の基底フォント（PDF組み込み・高品質）
  - HeiseiKakuGo-W5 … 日本語文字だけをXMLタグで切り替え
  - Courier        … コード・ファイル名などの等幅テキスト
"""

import re
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

pdfmetrics.registerFont(UnicodeCIDFont('HeiseiKakuGo-W5'))

JP  = 'HeiseiKakuGo-W5'   # 日本語用CIDフォント
HV  = 'Helvetica'          # ラテン文字基底（PDF組み込み）
HVB = 'Helvetica-Bold'     # 太字
CO  = 'Courier'            # 等幅（コード用）

# ── 日英混合テキスト変換 ─────────────────────────────────────────
def j(text):
    """
    日本語（非ASCII）文字だけをCIDフォントタグで囲む。
    Helveticaが基底なのでラテン文字は自動的に綺麗に表示される。
    """
    # XML特殊文字をエスケープ
    text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    # 日本語ランをCIDフォントに切り替え
    return re.sub(
        r'([^\x00-\x7F]+)',
        lambda m: f'<font name="{JP}">{m.group(0)}</font>',
        text
    )

def jb(text):
    """太字（見出し用）"""
    text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    return re.sub(
        r'([^\x00-\x7F]+)',
        lambda m: f'<font name="{JP}">{m.group(0)}</font>',
        text
    )

# ── カラー ──────────────────────────────────────────────────────
INK    = colors.HexColor('#1c1a18')
ACCENT = colors.HexColor('#c83535')
GOLD   = colors.HexColor('#b8882a')
MUTED  = colors.HexColor('#9a9080')
CREAM  = colors.HexColor('#f2ede4')
LINE   = colors.HexColor('#e0d9ce')
WARN_BG= colors.HexColor('#fff3f3')
NOTE_BG= colors.HexColor('#fffbe6')
DARK   = colors.HexColor('#1c1a18')
WHITE  = colors.white
LIGHT  = colors.HexColor('#fafaf8')

# ── スタイル（基底フォント = Helvetica）────────────────────────
def S(name, **kw):
    base = dict(fontName=HV, fontSize=9.5, leading=17, spaceAfter=3, textColor=INK)
    base.update(kw)
    return ParagraphStyle(name, **base)

ST = {
    'h1':     S('h1',    fontName=HVB, fontSize=13, leading=19, textColor=WHITE),
    'h2':     S('h2',    fontName=HVB, fontSize=10, leading=15, spaceBefore=10,
                 spaceAfter=3, textColor=ACCENT),
    'body':   S('body',  fontSize=9.5, leading=16, spaceAfter=2),
    'bullet': S('bullet',fontSize=9.5, leading=16, leftIndent=10, spaceAfter=2),
    'note':   S('note',  fontSize=8.5, leading=14, textColor=colors.HexColor('#7a6a00'),
                 leftIndent=6, rightIndent=6),
    'warn':   S('warn',  fontSize=8.5, leading=14, textColor=colors.HexColor('#5a1a1a'),
                 leftIndent=6, rightIndent=6),
    'code':   S('code',  fontName=CO,  fontSize=8.5, leading=13,
                 leftIndent=8, backColor=CREAM),
    'th':     S('th',    fontName=HVB, fontSize=8.5, leading=13, textColor=WHITE, alignment=1),
    'td':     S('td',    fontSize=8,   leading=13, textColor=INK),
    'tdc':    S('tdc',   fontSize=8,   leading=13, textColor=INK, alignment=1),
    'title':  S('title', fontName=HVB, fontSize=21, leading=28, textColor=WHITE),
    'tsub':   S('tsub',  fontSize=9,   leading=13, textColor=GOLD),
    'tdate':  S('tdate', fontSize=7.5, leading=11, textColor=MUTED),
}

# ── ショートハンド ───────────────────────────────────────────────
def sp(n=6):  return Spacer(1, n)
def hr():
    return HRFlowable(width='100%', thickness=0.5, color=LINE, spaceBefore=8, spaceAfter=8)

def P(text, sty='body'):    return Paragraph(j(text),  ST[sty])
def Praw(text, sty='body'): return Paragraph(text,     ST[sty])   # 既にタグ付き
def B(text):  return Paragraph('• ' + j(text), ST['bullet'])
def CB(text): return Paragraph('[ ] ' + j(text), ST['bullet'])
def H2(text): return Paragraph('■ ' + j(text), ST['h2'])

def code(text):
    escaped = text.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
    return Paragraph(escaped, ST['code'])

def note_box(text):
    t = Table([[P(text, 'note')]], colWidths=[170*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND',    (0,0),(-1,-1), NOTE_BG),
        ('BOX',           (0,0),(-1,-1), 0.5, LINE),
        ('TOPPADDING',    (0,0),(-1,-1), 6),
        ('BOTTOMPADDING', (0,0),(-1,-1), 6),
        ('LEFTPADDING',   (0,0),(-1,-1), 8),
        ('RIGHTPADDING',  (0,0),(-1,-1), 8),
    ]))
    return t

def warn_box(lines):
    """lines: list of (text, style_name) tuples"""
    content = [P(line, 'warn') for line in lines]
    t = Table([content], colWidths=[170*mm])
    t = Table([[Paragraph('<br/>'.join(
        j(l).replace('\n','<br/>') for l in lines
    ), ST['warn'])]], colWidths=[170*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND',    (0,0),(-1,-1), WARN_BG),
        ('BOX',           (0,0),(-1,-1), 1.5, ACCENT),
        ('TOPPADDING',    (0,0),(-1,-1), 7),
        ('BOTTOMPADDING', (0,0),(-1,-1), 7),
        ('LEFTPADDING',   (0,0),(-1,-1), 10),
        ('RIGHTPADDING',  (0,0),(-1,-1), 10),
    ]))
    return t

def section_header(text):
    t = Table([[Paragraph(j(text), ST['h1'])]], colWidths=[170*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND',    (0,0),(-1,-1), ACCENT),
        ('TOPPADDING',    (0,0),(-1,-1), 8),
        ('BOTTOMPADDING', (0,0),(-1,-1), 8),
        ('LEFTPADDING',   (0,0),(-1,-1), 10),
    ]))
    return t

def make_table(headers, rows, widths):
    header_cells = [Paragraph(j(h), ST['th']) for h in headers]
    table_rows = [header_cells]
    for row in rows:
        table_rows.append([Paragraph(j(c), ST['td']) for c in row])
    t = Table(table_rows, colWidths=widths)
    style = [
        ('BACKGROUND',    (0,0),(-1,0),  DARK),
        ('GRID',          (0,0),(-1,-1), 0.3, LINE),
        ('VALIGN',        (0,0),(-1,-1), 'TOP'),
        ('TOPPADDING',    (0,0),(-1,-1), 5),
        ('BOTTOMPADDING', (0,0),(-1,-1), 5),
        ('LEFTPADDING',   (0,0),(-1,-1), 6),
        ('RIGHTPADDING',  (0,0),(-1,-1), 6),
    ]
    for i in range(1, len(table_rows)):
        if i % 2 == 0:
            style.append(('BACKGROUND', (0,i),(-1,i), LIGHT))
    t.setStyle(TableStyle(style))
    return t

# ════════════════════════════════════════════════════════════════
# ストーリー
# ════════════════════════════════════════════════════════════════
story = []

# ── 表紙ヘッダー ────────────────────────────────────────────────
title_t = Table([
    [Paragraph(j('予約システム'),              ST['title'])],
    [Paragraph(j('運用・引き渡しガイド'),      ST['title'])],
    [Paragraph(j('着物レンタル予約システム（GAS + Pay.jp）'), ST['tsub'])],
    [Paragraph('Created: 2026-03-12  |  GAS @63  |  Tests: 46/46 PASS', ST['tdate'])],
], colWidths=[170*mm])
title_t.setStyle(TableStyle([
    ('BACKGROUND',    (0,0),(-1,-1), DARK),
    ('TOPPADDING',    (0,0),(-1,-1), 7),
    ('BOTTOMPADDING', (0,0),(-1,-1), 7),
    ('BOTTOMPADDING', (0,3),(-1,3), 14),
    ('LEFTPADDING',   (0,0),(-1,-1), 14),
]))
story += [title_t, sp(10)]

# ════════════════════════════════════════════════════════════════
# 1. 業者への引き渡し
# ════════════════════════════════════════════════════════════════
story += [
    section_header('1.  業者への引き渡し時に必要なこと'),
    sp(6),
    H2('渡すファイル（業者へ）'),
    B('reserve.html             ← 予約フォーム'),
    B('my-reservation.html      ← 予約確認・キャンセルページ'),
    B('privacy.html             ← プライバシーポリシー'),
    B('tokushoho.html           ← 特定商取引法'),
    sp(6),
    H2('渡さないファイル（御社で管理）'),
    B('gas-calendar-api.gs      ← Google アカウントに紐づくため'),
    B('.clasp.json              ← 秘密情報（scriptId 等）含む'),
    B('test-booking-system.sh   ← 開発用テストスクリプト'),
    sp(8),
    H2('システム構成（GAS の所有権について）'),
    P('GAS（バックエンド）は御社の Google アカウントに紐づいており、'
      '業者がサーバーに移すことはできません。'
      '業者には GAS の URL（deploymentId）だけを共有すれば十分です。'),
    sp(4),
    make_table(
        ['業者のサーバー（HP）', '通信', '御社の Google アカウント'],
        [
            ['reserve.html（埋め込み）', '─ fetch →', 'GAS Web App（バックエンド・DB・メール送信）'],
            ['', '', '↓   Google スプレッドシート（予約データ保存）'],
        ],
        [60*mm, 22*mm, 88*mm]
    ),
    sp(10),
    H2('引き渡しチェックリスト'),
    P('【業者側の作業】'),
    CB('reserve.html を HP に組み込む（iframe 埋め込み or 直接配置）'),
    CB('privacy.html / tokushoho.html のリンク確認'),
    CB('HTTPS であること確認（Pay.jp は HTTPS 必須）'),
    CB('本番ドメインの CORS ポリシー確認'),
    sp(4),
    P('【御社側で事前に行う作業】'),
    CB('Pay.jp 本番キーへの切り替え（最重要）'),
    CB('GAS のスクリプトプロパティを本番用に設定'),
    CB('管理者メールアドレスの確認'),
    sp(6),
    warn_box([
        '[!] 重要：Pay.jp 本番キー切り替え手順',
        '現在はテストキーが設定されています。本番公開前に必ず変更してください。',
        '',
        '(1)  reserve.html の PAYJP_PUBLIC_KEY を pk_live_XXXX に変更',
        '(2)  GAS エディタ → プロジェクトの設定 → スクリプトプロパティ',
        '     payjp_secret_key の値を sk_live_XXXX（本番秘密キー）に変更',
    ]),
    sp(4),
]

# ════════════════════════════════════════════════════════════════
# 2. 本番稼働後の運用
# ════════════════════════════════════════════════════════════════
story += [
    hr(),
    section_header('2.  本番稼働後のバグ修正・アップデート運用'),
    sp(6),
    H2('変更時の作業フロー'),
    make_table(
        ['Step', '作業', 'コマンド / 備考'],
        [
            ['(1)', 'コード修正',           'テキストエディタ / Claude Code'],
            ['(2)', 'ローカルでテスト',     'プレビューサーバーで確認'],
            ['(3)', 'テストスイート実行',   'bash test-booking-system.sh'],
            ['(4)', 'GAS にプッシュ',       'npx clasp push'],
            ['(5)', 'GAS デプロイ',         'npx clasp deploy --deploymentId "AKfycbx..."'],
            ['(6)', 'HTML ファイル更新',    '業者サーバーに reserve.html を送付\n（GAS のみ変更なら不要）'],
            ['(7)', '本番動作確認',         'テストカードで予約フロー通し確認'],
        ],
        [12*mm, 46*mm, 112*mm]
    ),
    sp(10),
    H2('推奨テスト周期'),
    make_table(
        ['周期', '内容', '目安'],
        [
            ['変更のたびに', 'テストスイート実行（bash test-booking-system.sh）', '約 1 分'],
            ['変更のたびに', 'ブラウザで予約フロー手動確認（テストカード使用）',   '約 5 分'],
            ['月 1 回',      'テスト予約で決済・メール・スプレッドシートを一括確認', '約 15 分'],
            ['四半期ごと',   'Pay.jp ダッシュボードで取引記録の突合',             '約 30 分'],
            ['年 1 回',      'payjp.js 等の依存ライブラリバージョン確認・更新',    '約 1 時間'],
        ],
        [28*mm, 112*mm, 30*mm]
    ),
    sp(10),
    H2('月次チェック手順'),
    note_box('テストカード番号：4242 4242 4242 4242   有効期限：未来の任意   CVC：任意 3 桁'),
    sp(3),
    B('(1) テストスイート実行：bash test-booking-system.sh'),
    B('(2) テスト予約を通してスプレッドシートに記録されるか確認'),
    B('(3) 確認メールが届くか確認'),
    B('(4) my-reservation.html でキャンセルできるか確認'),
    B('(5) テスト予約をスプレッドシートから手動削除'),
    sp(8),
    H2('バグ発生時の対応フロー'),
    B('(1) ユーザーから報告を受ける'),
    B('(2) GAS のログを確認（GAS エディタ → 実行数 → ログ）'),
    B('(3) 問題の特定・コード修正'),
    B('(4) テストスイート実行'),
    B('(5) デプロイ（GAS のみの修正は URL が変わらないため業者への連絡不要）'),
    sp(8),
    H2('バックアップ体制'),
    B('GitHub                  : HTML ファイル（github.com/yossi-akari/kimono-calendar）'),
    B('Google スプレッドシート : 予約データ（自動保存）'),
    B('GAS プロジェクト        : バックエンドコード（Google サーバー上）'),
    sp(4),
    note_box(
        '[*] 推奨：月 1 回、スプレッドシートを Excel 形式（.xlsx）でダウンロードして保存してください。\n'
        '    Google アカウントに問題が生じた場合の予約データ保全になります。'
    ),
    sp(4),
]

# ════════════════════════════════════════════════════════════════
# 3. 重要情報まとめ
# ════════════════════════════════════════════════════════════════
story += [
    hr(),
    section_header('3.  重要情報まとめ'),
    sp(6),
    make_table(
        ['項目', '値 / 場所'],
        [
            ['GAS deploymentId',   'AKfycbx347zA3An_FRMxeBLEQVLCbGRgLBiUinEt8OL2I-H91ixNlqwT6lXb-9-_rP_ZowrbKw'],
            ['GAS バージョン',     '@63（最新）'],
            ['予約ページ URL',     'https://yossi-akari.github.io/kimono-calendar/reserve.html'],
            ['予約確認 URL',       'https://yossi-akari.github.io/kimono-calendar/my-reservation.html'],
            ['スプレッドシート ID','1zHA2c_0_woks-9x7iRojlDkuXNLXV0dKiuZEIxcfqEE'],
            ['ソースコード',       '/Users/yossi/my-app/'],
            ['GitHub リポジトリ',  '/Users/yossi/Documents/GitHub/kimono-calendar/'],
            ['テストスイート',     '/Users/yossi/my-app/test-booking-system.sh（46 テスト）'],
            ['Pay.jp モード',      '現在：テストモード → 本番前に本番キーへ切り替え必須'],
            ['スロット容量',       'SLOT_CAPACITY = 1（1 グループ / 30 分枠）'],
            ['レート制限',         '予約：3 回/5 分/メール   OTP：5 回まで/セッション'],
        ],
        [50*mm, 120*mm]
    ),
    sp(8),
    note_box(
        '※ このガイドは 2026 年 3 月時点の情報です。システム変更時は適宜更新してください。\n'
        '※ 本番稼働前に必ず Pay.jp 本番キーへの切り替えを行ってください。'
    ),
]

# ── PDF 出力 ─────────────────────────────────────────────────────
OUTPUT = '/Users/yossi/my-app/予約システム_運用引き渡しガイド.pdf'

def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFont(HV, 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(A4[0]/2, 10*mm, f'— {canvas.getPageNumber()} —')
    if canvas.getPageNumber() > 1:
        canvas.setStrokeColor(LINE)
        canvas.line(20*mm, A4[1]-14*mm, A4[0]-20*mm, A4[1]-14*mm)
        canvas.setFont(JP, 7.5)
        canvas.drawString(20*mm, A4[1]-12*mm, '予約システム 運用・引き渡しガイド')
    canvas.restoreState()

doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=A4,
    leftMargin=20*mm, rightMargin=20*mm,
    topMargin=18*mm,  bottomMargin=18*mm,
    title='予約システム 運用・引き渡しガイド',
    author='あかり',
)
doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print(f'完了: {OUTPUT}')
