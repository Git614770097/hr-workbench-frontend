#!/usr/bin/env bash
# 发版脚本：对齐版本号 + 生成公告草稿 + 打 git tag
# 用法：bash scripts/release.sh v1.4
#   1) package.json version 对齐（v1.4 -> 1.4.0）
#   2) 生成 scripts/changelog-<ver>.sql 草稿（改完再执行写入 D1）
#   3) git tag <ver>（不自动 push，确认后再 git push github main --tags）
set -euo pipefail

VER="${1:-}"
if [[ -z "$VER" ]]; then
  echo "用法: bash scripts/release.sh v1.4"
  exit 1
fi
if [[ ! "$VER" =~ ^v[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  echo "版本号格式应为 v1.4 或 v1.4.1，收到: $VER"
  exit 1
fi

cd "$(dirname "$0")/.."

# v1.4 -> 1.4.0 ; v1.4.1 -> 1.4.1
NUM="${VER#v}"
if [[ "$NUM" =~ ^[0-9]+\.[0-9]+$ ]]; then
  NUM="$NUM.0"
fi

node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json','utf8'));
p.version = '$NUM';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
console.log('package.json version -> ' + p.version);
"

TODAY=$(date +%Y-%m-%d)
DRAFT="scripts/changelog-$VER.sql"
if [[ -f "$DRAFT" ]]; then
  echo "草稿已存在，不覆盖: $DRAFT"
else
  cat > "$DRAFT" <<EOF
-- $VER 更新公告草稿（生成于 $TODAY）
-- 改完 items 后执行：npx wrangler d1 execute hr-workbench --remote --file=$DRAFT
-- 写入方式与 PUT /auth/settings/changelog 一致（会自动归档旧公告到 app_changelog_history）
INSERT INTO site_settings (key, value) VALUES (
  'app_changelog',
  '{"version":"$VER","title":"$VER 更新公告","updated_at":"$TODAY","items":["待补充：功能点 1","待补充：功能点 2"]}'
)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- 归档上一条到历史（如已有 app_changelog_history 可跳过此段，优先用后台「更新公告」保存）
EOF
  echo "公告草稿 -> $DRAFT"
fi

if git rev-parse "$VER" >/dev/null 2>&1; then
  echo "tag $VER 已存在，跳过打 tag"
else
  git tag "$VER"
  echo "git tag $VER 已创建（未 push）"
fi

echo ""
echo "后续："
echo "  1. 编辑 $DRAFT 的 items 后执行写入 D1"
echo "  2. git add -A && git commit -m \"release: $VER\""
echo "  3. git push github main --tags"
