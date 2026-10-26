#!/usr/bin/env bash
# 部署后冒烟检查（本地 dist 与线上对一遍，全过才算部署成功）。
# 用法：npm run build && npx wrangler deploy && bash scripts/smoke.sh
#
# 注意：沙箱/代理环境下 curl 频繁 HTTP:000，所有请求必须带重试循环；
#       绝对耗时不可信（TLS/代理开销大），本脚本只看状态码与内容一致性。
set -u

SITE="${SITE:-https://hr-work.club}"
DIST="${DIST:-dist/client}"
FAIL=0

# 请求重试：$1=输出文件（可空） $2...=curl 参数
fetch() {
  local out="$1"; shift
  for i in 1 2 3 4 5; do
    if [ -n "$out" ]; then
      code=$(curl -s -o "$out" -w "%{http_code}" --max-time 20 "$@" 2>/dev/null)
    else
      code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$@" 2>/dev/null)
    fi
    [ "$code" != "000" ] && return 0
    sleep 2
  done
  return 0
}

check() {
  local desc="$1" expect="$2" actual="$3"
  if [ "$expect" = "$actual" ]; then
    echo "  OK  $desc ($actual)"
  else
    echo "FAIL  $desc — 期望 $expect 实得 $actual"
    FAIL=1
  fi
}

echo "== 1. 首页与入口 chunk =="
fetch /tmp/smoke-home.html "$SITE/"
check "首页 HTTP" 200 "$code"
if [ ! -s /tmp/smoke-home.html ]; then echo "FAIL  首页内容为空"; FAIL=1; fi

LOCAL_ENTRY=$(grep -o 'assets/index-[^"]*\.js' "$DIST/index.html" 2>/dev/null | head -1)
LIVE_ENTRY=$(grep -o 'assets/index-[^"]*\.js' /tmp/smoke-home.html 2>/dev/null | head -1)
check "入口 chunk 文件名一致" "${LOCAL_ENTRY:-none}" "${LIVE_ENTRY:-none}"

echo "== 2. 入口 chunk 字节数（防 CDN 半截/旧版本） =="
if [ -n "$LOCAL_ENTRY" ] && [ -n "$LIVE_ENTRY" ] && [ "$LOCAL_ENTRY" = "$LIVE_ENTRY" ]; then
  LOCAL_SIZE=$(stat -c%s "$DIST/$LOCAL_ENTRY" 2>/dev/null || echo 0)
  # 代理/沙箱下 curl 会把大文件截断（HTTP 200 但字节数不够），必须按「大小一致」重试
  LIVE_SIZE=0
  for i in 1 2 3 4 5 6 7 8; do
    fetch /tmp/smoke-entry.js "$SITE/$LIVE_ENTRY"
    LIVE_SIZE=$(stat -c%s /tmp/smoke-entry.js 2>/dev/null || echo 0)
    [ "$LIVE_SIZE" = "$LOCAL_SIZE" ] && break
    sleep 3
  done
  check "入口 chunk 字节一致" "$LOCAL_SIZE" "$LIVE_SIZE"
fi

echo "== 3. 关键接口状态码 =="
fetch "" "$SITE/api/health"
check "GET /api/health" 200 "$code"
# 错误上报：匿名可写（登录页白屏也要能留痕）
fetch "" -X POST -H "Content-Type: application/json" -d '{"message":"smoke-test"}' "$SITE/api/logs/client-error"
check "POST /api/logs/client-error（匿名）" 200 "$code"
# 已下线接口必须 404（回归防线）
fetch "" "$SITE/api/background"
check "GET /api/background（应已下线）" 404 "$code"
fetch "" "$SITE/api/logs/overview"
check "GET /api/logs/overview（应已下线）" 404 "$code"
# 未登录查询接口应 401（而不是 500）
fetch "" "$SITE/api/audit"
check "GET /api/audit（未登录）" 401 "$code"

echo
if [ "$FAIL" = "0" ]; then
  echo "冒烟通过 ✔"
else
  echo "冒烟失败 ✘（见上方 FAIL 项）"
  exit 1
fi
