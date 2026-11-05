#!/usr/bin/env bash
# 집 PC: 오라클 보관소(tools/watch.js)의 큐에 새 빌드가 있으면 처리한다.
#   번들·매니페스트 받기 → 짝 검증 → 감사(OCR) → 이미지 색인 → 드리프트 리포트 → 결과를 오라클에 올리기
# 배포(npm run deploy)와 커밋은 하지 않는다. 리포트를 보고 사람이 한다.
# tools/worker.sh [--force]   큐가 비어 있어도 돈다
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${MJSKR_HOST:-diphy-oci}
REMOTE=${MJSKR_REMOTE:-mjskr-archive}
LOCAL=.cache/archive
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o IPQoS=none)
RSYNC=(rsync -a -e "ssh -o BatchMode=yes -o ConnectTimeout=15 -o IPQoS=none")
mkdir -p "$LOCAL"

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

node swap.js
.venv/bin/python -I tools/audit.py
node swap.js
.venv/bin/python -I tools/imgindex.py

snap=$(ls swapdb/builds | sort | tail -1)
report="$LOCAL/reports/${snap%.json}.md"
node tools/drift.js --out "$report" > /dev/null
mkdir -p "$LOCAL/swapjson" && cp public/swap.json "$LOCAL/swapjson/${snap%.json}.json"

# 결과 기록을 오라클에 보관한다. 이미지·색인은 내용 해시라 덮어쓰지 않는다.
"${RSYNC[@]}" --ignore-existing --exclude '*.part' "$LOCAL/img" "$LOCAL/index" "$HOST:$REMOTE/"
"${RSYNC[@]}" "$LOCAL/reports" "$LOCAL/swapjson" swapdb "$HOST:$REMOTE/"
if [ -n "$jobs" ]; then
  # 처리하는 동안 새로 들어온 작업은 남긴다
  "${SSH[@]}" "$HOST" "mkdir -p $REMOTE/done && cd $REMOTE/queue && mv $(echo $jobs) ../done/"
fi
rm -f "$FAILED"

summary=$(sed -n '/^\*\*볼 것/,/^$/p' "$report")
echo "$summary"
notify "mahjongsoulKR: 새 빌드 처리함" "$summary
$report"
