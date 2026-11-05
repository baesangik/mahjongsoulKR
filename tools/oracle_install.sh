#!/usr/bin/env bash
# 집 PC에서 실행: 감시 코드(tools/watch.js·canary.js + src/core.js·inject.lua)와 systemd 유닛을 오라클에 올리고 켠다.
# 코드를 고쳤을 때도 이걸 다시 돌리면 된다. 보관소(~/mjskr-archive)는 건드리지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${MJSKR_HOST:-diphy-oci}
SSH=(ssh -o BatchMode=yes -o IPQoS=none)
"${SSH[@]}" "$HOST" 'mkdir -p ~/mjskr/src ~/mjskr/tools ~/mjskr-archive'
rsync -a -e "${SSH[*]}" src/core.js src/inject.lua "$HOST:mjskr/src/"
rsync -a -e "${SSH[*]}" tools/watch.js tools/canary.js "$HOST:mjskr/tools/"
rsync -a -e "${SSH[*]}" tools/systemd/oracle/ "$HOST:mjskr/systemd/"
"${SSH[@]}" "$HOST" 'sudo cp ~/mjskr/systemd/mjskr-watch.* /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now mjskr-watch.timer && systemctl list-timers mjskr-watch.timer --no-pager'
