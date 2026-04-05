#!/bin/bash
# ================================================================
# GAS デプロイスクリプト
# 使い方:
#   ./deploy.sh          → コードをプッシュして新バージョンをデプロイ
#   ./deploy.sh --push   → コードのプッシュのみ（デプロイなし）
# ================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# .clasp.json のスクリプトIDが設定済みか確認
SCRIPT_ID=$(python3 -c "import json; print(json.load(open('.clasp.json'))['scriptId'])" 2>/dev/null || echo "")
if [ "$SCRIPT_ID" = "YOUR_SCRIPT_ID_HERE" ] || [ -z "$SCRIPT_ID" ]; then
  echo "❌ .clasp.json の scriptId を設定してください"
  echo ""
  echo "取得方法:"
  echo "  1. https://script.google.com を開く"
  echo "  2. 対象のプロジェクトを開く"
  echo "  3. プロジェクトの設定 → スクリプト ID をコピー"
  echo "  4. .clasp.json の YOUR_SCRIPT_ID_HERE を置き換える"
  exit 1
fi

# ログイン状態確認
if ! clasp status &>/dev/null; then
  echo "🔑 Googleアカウントでログインしてください..."
  clasp login
fi

echo "📤 コードをプッシュ中..."
clasp push --force

if [ "$1" = "--push" ]; then
  echo "✅ プッシュ完了（デプロイはスキップ）"
  exit 0
fi

# デプロイIDが設定されていればデプロイ、なければプッシュのみ
DEPLOY_ID=$(python3 -c "import json; d=json.load(open('.clasp.json')); print(d.get('deploymentId',''))" 2>/dev/null || echo "")

if [ -z "$DEPLOY_ID" ]; then
  echo ""
  echo "⚠️  デプロイIDが未設定のため、プッシュのみ実施しました"
  echo ""
  echo "本番デプロイを行うには:"
  echo "  1. GASエディタ → デプロイ → デプロイを管理"
  echo "  2. 鉛筆アイコン → バージョン: 新しいバージョン → デプロイ"
  echo "  3. デプロイIDをコピーして .clasp.json に追加:"
  echo '     { "scriptId": "...", "deploymentId": "...", "rootDir": "." }'
  echo "  4. 次回以降は ./deploy.sh で自動デプロイされます"
else
  echo "🚀 デプロイ中 (ID: $DEPLOY_ID)..."
  clasp deploy --deploymentId "$DEPLOY_ID" --description "Deploy $(date '+%Y-%m-%d %H:%M')"
  echo "✅ デプロイ完了"
fi
