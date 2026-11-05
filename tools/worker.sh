#!/usr/bin/env bash
# 집 PC: 오라클 보관소(tools/watch.js)의 큐에 새 빌드가 있으면 처리한다.
#   번들·매니페스트 받기 → canary → 짝 검증 → 감사(OCR) → 이미지 색인 → 드리프트 리포트 → 게이트 → 스모크 → 결과를 오라클에 올리기
# 커밋은 하지 않는다. 배포도 기본으로는 하지 않고, 게이트를 통과하면 "게시 가능"만 알린다.
# ~/.config/mjskr-worker.env 에 MJSKR_AUTODEPLOY=1 이 있으면 게이트를 통과했을 때 swap.json을 바로 올린다
# (npx wrangler deploy, public/은 커밋된 그대로). 올린 기록은 오라클 published.jsonl에 남는다.
# tools/worker.sh [--force]   큐가 비어 있어도 돈다
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${MJSKR_HOST:-diphy-oci}
REMOTE=${MJSKR_REMOTE:-mjskr-archive}
LOCAL=.cache/archive
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o IPQoS=none)
RSYNC=(rsync -a -e "ssh -o BatchMode=yes -o ConnectTimeout=15 -o IPQoS=none")
mkdir -p "$LOCAL/lua" "$LOCAL/canary"

exec 9>.cache/worker.lock
flock -n 9 || exit 0

# 실패하면 한 시간 동안은 다시 시도하지 않는다 (같은 실패로 매번 무거운 작업을 돌리지 않게)
FAILED=.cache/worker.failed
if [ "${1:-}" != --force ] && [ -e "$FAILED" ] && [ -n "$(find "$FAILED" -mmin -60)" ]; then exit 0; fi

jobs=$("${SSH[@]}" "$HOST" "ls $REMOTE/queue 2>/dev/null" || true)
[ -n "$jobs" ] || [ "${1:-}" = --force ] || exit 0
echo "jobs: ${jobs:-(none, forced)}"

notify() { notify-send -a mahjongsoulKR "$@" 2>/dev/null || true; }
trap 'touch "$FAILED"; notify -u critical "mahjongsoulKR 작업 실패" "journalctl --user -u mjskr-worker"' ERR

"${RSYNC[@]}" --ignore-existing --exclude '*.part' "$HOST:$REMOTE/ab" "$HOST:$REMOTE/manifests" "$LOCAL/"

# canary는 실패해도 계속 간다: 리포트에 넣고 게이트가 막는다
node tools/canary.js || true
node swap.js
.venv/bin/python -I tools/audit.py
node swap.js
.venv/bin/python -I tools/imgindex.py

snap=$(ls swapdb/builds | sort | tail -1)
report="$LOCAL/reports/${snap%.json}.md"
node tools/drift.js --out "$report" --json "$LOCAL/reports/${snap%.json}.json" > /dev/null
gate=0
gate_out=$(node tools/gate.js --drift "$LOCAL/reports/${snap%.json}.json") || gate=$?
echo "$gate_out"
[ "$gate" -le 2 ] || false   # 1 = gate.js 자체 오류
# 게이트를 통과하면 실제 게임을 Chrome으로 띄워 타이틀까지 확인한다 (MJSKR_SMOKE=0이면 건너뜀)
if [ "$gate" = 0 ] && [ "${MJSKR_SMOKE:-1}" = 1 ]; then
  smoke=0
  smoke_out=$(node tools/smoke.js --out "$LOCAL/smoke/${snap%.json}" 2>&1) || smoke=$?
  echo "$smoke_out"
  if [ "$smoke" != 0 ]; then gate=2; gate_out="게시 안 함: 스모크 테스트 실패
$(echo "$smoke_out" | grep -E '^FAIL|Error' | head -5)"; fi
fi
published=
if [ "$gate" = 0 ] && [ "${MJSKR_AUTODEPLOY:-0}" = 1 ]; then
  npx wrangler deploy
  published=1
  "${SSH[@]}" "$HOST" "echo '{\"at\":\"$(date -Is)\",\"snapshot\":\"$snap\",\"commit\":\"$(git rev-parse --short HEAD)\"}' >> $REMOTE/published.jsonl"
fi
mkdir -p "$LOCAL/swapjson" && cp public/swap.json "$LOCAL/swapjson/${snap%.json}.json"

# 결과 기록을 오라클에 보관한다. 이미지·색인·Lua는 내용 해시라 덮어쓰지 않는다.
"${RSYNC[@]}" --ignore-existing --exclude '*.part' "$LOCAL/img" "$LOCAL/index" "$LOCAL/lua" "$HOST:$REMOTE/"
mkdir -p "$LOCAL/smoke"
"${RSYNC[@]}" "$LOCAL/reports" "$LOCAL/smoke" "$LOCAL/swapjson" "$LOCAL/canary" swapdb "$HOST:$REMOTE/"
if [ -n "$jobs" ]; then
  # 처리하는 동안 새로 들어온 작업은 남긴다
  "${SSH[@]}" "$HOST" "mkdir -p $REMOTE/done && cd $REMOTE/queue && mv $(echo $jobs) ../done/"
fi
rm -f "$FAILED"

summary=$(sed -n '/^\*\*볼 것/,/^$/p' "$report")
echo "$summary"
if [ -n "$published" ]; then
  notify "mahjongsoulKR: swap.json 올림" "$summary
$report"
elif [ "$gate" = 0 ]; then
  notify "mahjongsoulKR: 게시 가능 (npm run deploy)" "$summary
$report"
else
  notify -u critical "mahjongsoulKR: 게시 안 함" "$gate_out
$report"
fi
