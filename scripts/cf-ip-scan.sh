#!/usr/bin/env bash
# Cloudflare 边缘 IP 诊断 / 优选扫描
#
# 原理：Cloudflare 是全球 anycast，同一域名在所有边缘 IP 上都能访问，但「你的 ISP
# 到某个 anycast IP」走哪条国际路由、落到哪个机房，是按 IP 段分别决定的。所以换 IP
# 理论上可能从慢机房换到快机房。
#
# 用法：
#   bash scripts/cf-ip-scan.sh                     # 扫 hr-work.club
#   HOST=example.com bash scripts/cf-ip-scan.sh
#   THROUGHPUT=1 bash scripts/cf-ip-scan.sh        # 追加吞吐测试（慢，约 5~10 分钟）
#   NOPROXY=1 bash scripts/cf-ip-scan.sh           # 绕过本机 HTTP 代理直连
#
# ⚠️ 两个必须知道的坑（都是实测踩出来的）：
#   1) TTFB 不能用来选 IP。实测 TTFB 最好的 104.16.50.1 吞吐为 0，而 TTFB 中游的
#      IP 反而能到 20KB/s+。要选就测吞吐，但吞吐抖动极大，必须多次取中位数。
#   2) 本机若开了 HTTP 代理（https_proxy），所有测速都经过代理，结果不代表真实链路。
#      对比一次 NOPROXY=1 和默认的结果，差异大说明代理在拖慢。
set -uo pipefail

HOST="${HOST:-hr-work.club}"
OUT="${OUT:-/tmp/cfscan}"
PARALLEL="${PARALLEL:-12}"
TIMEOUT="${TIMEOUT:-12}"
THROUGHPUT="${THROUGHPUT:-0}"
NOPROXY="${NOPROXY:-0}"
TRIALS="${TRIALS:-3}"

CURL_OPTS=()
if [ "$NOPROXY" = "1" ]; then CURL_OPTS+=(--noproxy '*'); fi

rm -rf "$OUT"; mkdir -p "$OUT"

# 候选 IP：每个 Cloudflare 官方段取若干采样点
# （段列表见 https://www.cloudflare.com/ips/）
IPS="
104.16.0.1 104.16.50.1 104.16.100.1 104.16.150.1 104.16.200.1 104.16.250.1
104.17.0.1 104.17.50.1 104.17.100.1 104.17.150.1 104.17.200.1 104.17.250.1
104.18.0.1 104.18.50.1 104.18.100.1 104.18.150.1 104.18.200.1 104.18.250.1
104.19.0.1 104.19.50.1 104.19.100.1 104.19.150.1 104.19.200.1 104.19.250.1
104.20.0.1 104.20.50.1 104.20.100.1 104.20.150.1 104.20.200.1 104.20.250.1
104.21.0.1 104.21.50.1 104.21.100.1 104.21.150.1 104.21.200.1 104.21.250.1
104.22.0.1 104.22.50.1 104.22.100.1 104.22.150.1 104.22.200.1 104.22.250.1
104.23.0.1 104.23.50.1 104.23.100.1 104.23.150.1 104.23.200.1 104.23.250.1
104.24.0.1 104.24.50.1 104.24.100.1 104.24.150.1 104.24.200.1 104.24.250.1
104.25.0.1 104.25.50.1 104.25.100.1 104.25.150.1 104.25.200.1 104.25.250.1
104.26.0.1 104.26.50.1 104.26.100.1 104.26.150.1 104.26.200.1 104.26.250.1
104.27.0.1 104.27.50.1 104.27.100.1 104.27.150.1 104.27.200.1 104.27.250.1
172.64.0.1 172.64.50.1 172.64.100.1 172.64.150.1 172.64.200.1 172.64.250.1
172.65.0.1 172.65.50.1 172.65.100.1 172.65.150.1 172.65.200.1 172.65.250.1
172.66.0.1 172.66.50.1 172.66.100.1 172.66.150.1 172.66.200.1 172.66.250.1
172.67.0.1 172.67.50.1 172.67.100.1 172.67.150.1 172.67.200.1 172.67.250.1
172.68.0.1 172.68.50.1 172.68.100.1 172.68.150.1 172.68.200.1 172.68.250.1
172.69.0.1 172.69.50.1 172.69.100.1 172.69.150.1 172.69.200.1 172.69.250.1
172.70.0.1 172.70.50.1 172.70.100.1 172.70.150.1 172.70.200.1 172.70.250.1
172.71.0.1 172.71.50.1 172.71.100.1 172.71.150.1 172.71.200.1 172.71.250.1
162.158.0.1 162.158.50.1 162.158.100.1 162.158.150.1 162.158.200.1 162.158.250.1
162.159.0.1 162.159.50.1 162.159.100.1 162.159.150.1 162.159.200.1 162.159.250.1
188.114.96.1 188.114.97.1 188.114.98.1 188.114.99.1
197.234.240.1 197.234.241.1
198.41.128.1 198.41.129.1 198.41.200.1 198.41.201.1
103.21.244.1 103.22.200.1 103.31.4.1
108.162.192.1 108.162.193.1 108.162.194.1 108.162.195.1
131.0.72.1
141.101.64.1 141.101.65.1 141.101.66.1 141.101.67.1 141.101.68.1 141.101.69.1
141.101.70.1 141.101.71.1 141.101.72.1 141.101.73.1 141.101.74.1 141.101.75.1
141.101.76.1 141.101.77.1 141.101.78.1 141.101.79.1
173.245.48.1 173.245.49.1
190.93.240.1 190.93.241.1 190.93.242.1 190.93.243.1
"

# ── 阶段 1：探活 + 取机房 ────────────────────────────────────────────────
probe_one() {
  local ip="$1"
  local body="$OUT/$ip.body"
  local m
  m=$(curl -s -o "$body" --max-time "$TIMEOUT" "${CURL_OPTS[@]}" \
        --resolve "$HOST:443:$ip" "https://$HOST/cdn-cgi/trace" \
        -w "%{http_code}|%{time_connect}|%{time_appconnect}|%{time_starttransfer}|%{time_total}" \
        2>/dev/null)
  local colo
  colo=$(grep -o 'colo=[A-Za-z0-9]*' "$body" 2>/dev/null | cut -d= -f2)
  [ -z "$colo" ] && colo="-"
  if [ "${m%%|*}" = "200" ] && [ "$colo" != "-" ]; then
    printf '%s|%s\n' "$ip" "$colo|$m" >> "$OUT/ok.txt"
  else
    printf '%s|%s\n' "$ip" "FAIL|$m" >> "$OUT/fail.txt"
  fi
}
export -f probe_one
export HOST OUT TIMEOUT

echo "阶段 1：探活 $HOST（$(echo "$IPS" | wc -w) 个候选 IP，并发 $PARALLEL，NOPROXY=$NOPROXY）"
echo "$IPS" | tr ' ' '\n' | grep . | xargs -P "$PARALLEL" -I{} bash -c 'probe_one "$@"' _ {} >/dev/null 2>&1

OK_N=$(wc -l < "$OUT/ok.txt" 2>/dev/null || echo 0)
echo "  可达 $OK_N 个"
echo
echo "=== 机房分布（关键：若全是同一个机房，说明 ISP 路由固定，换 IP 无意义）==="
cut -d'|' -f2 "$OUT/ok.txt" 2>/dev/null | sort | uniq -c | sort -rn | sed 's/^/  /'
echo

# ok.txt 每行：ip|colo|code|connect|appconnect|starttransfer|total
echo "=== 延迟参考（仅参考，不能用来选 IP）前 10 ==="
printf "  %-16s %-6s %8s\n" IP COLO TTFB
awk -F'|' '{printf "  %-16s %-6s %6.0fms\n", $1, $2, $6*1000}' "$OUT/ok.txt" 2>/dev/null \
  | sort -k3 -n | head -10
echo

# ── 阶段 2（可选）：吞吐 ────────────────────────────────────────────────
if [ "$THROUGHPUT" != "1" ]; then
  echo "（要测吞吐请加 THROUGHPUT=1，会慢 5~10 分钟）"
  exit 0
fi

ASSET=$(curl -s --max-time 20 "${CURL_OPTS[@]}" "https://$HOST/" 2>/dev/null \
        | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)
if [ -z "$ASSET" ]; then
  echo "取不到入口 asset，跳过吞吐测试"
  exit 1
fi
echo "阶段 2：吞吐测试（样本 $ASSET，每个 IP 测 $TRIALS 次取中位数）"
echo "  注意：链路抖动极大，单次结果没有意义；若同一 IP 多次结果相差 10 倍以上，"
echo "        说明瓶颈是链路拥塞而非 IP 选择，优选 IP 无效。"
echo

measure() {
  local ip="$1" label="$2"
  local vals=()
  for i in $(seq "$TRIALS"); do
    local sp
    if [ "$label" = "default" ]; then
      sp=$(curl -s -o /dev/null --max-time 15 "${CURL_OPTS[@]}" \
            -w "%{speed_download}" "https://$HOST$ASSET?cb=$RANDOM$i" 2>/dev/null)
    else
      sp=$(curl -s -o /dev/null --max-time 15 "${CURL_OPTS[@]}" \
            --resolve "$HOST:443:$ip" -w "%{speed_download}" "https://$HOST$ASSET?cb=$RANDOM$i" 2>/dev/null)
    fi
    vals+=("${sp%.*}")
  done
  local sorted med
  sorted=$(printf '%s\n' "${vals[@]}" | sort -n)
  med=$(echo "$sorted" | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}')
  local disp=""
  for v in "${vals[@]}"; do disp="$disp $((v/1024))"; done
  printf "  %-16s %-12s 中位 %4dKB/s  (各次:%s )\n" "$ip" "$label" "$((med/1024))" "$disp"
}

measure "default" "default"
for ip in $(cut -d'|' -f1 "$OUT/ok.txt" 2>/dev/null | head -10); do
  measure "$ip" ""
done
