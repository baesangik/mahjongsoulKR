# mahjongsoulKR

일본 서버 작혼(웹, `game.mahjongsoul.com`)의 텍스트를 게임에 내장된 한국어로 표시하는 비공식 유저스크립트.

설치 안내: https://jakhon.chamchi.me

> 팬메이드 모드이며 게임 운영사와 관련이 없다. 클라이언트를 수정하므로 계정 제재 가능성이 0은 아니다. 사용 책임은 본인에게 있다.

## 원리

웹판은 Unity WebGL + xLua 구조다. 일섭 클라이언트(`client_language=jp`)도 한국어 텍스트·폰트(`fonts/kr`)를 CDN에서 받을 수 있지만, `LangMgr.Init`이 일섭에서는 표시 언어를 `jp`로만 허용한다.

스크립트가 하는 일:

1. `fetch`를 감싼다 (`@run-at document-start`).
2. 번들 목록(`bundle_info_so.majset`)이 오면 `GameMgr.lua`를 가진 번들을 에셋 경로로 찾는다.
3. 그 번들을 받아 UnityFS(LZ4)를 풀고, XOR로 가려진 `GameMgr.lua`의 끝(`return GameMgr` 앞)에 `src/inject.lua`를 덧붙인 뒤 비압축 번들로 다시 묶는다. 번들 목록의 `fileSize`도 맞춰 고친다.
4. 게임이 그 번들을 요청하면 수정본을 준다.
5. 주입된 Lua가 `fonts/kr`를 먼저 로드하고, `LangMgr.Init` 직후와 `UIMgr:Init` 직전에 `prefer_language=kr`로 둔다. `client_language`(서버/지역)는 건드리지 않는다.

업데이트에 덜 깨지게 한 부분:

- 번들 이름은 하드코딩하지 않는다. 매번 번들 목록에서 찾는다.
- XOR 키는 알려진 키를 먼저 쓰고, 안 맞으면 글자 빈도로 새로 찾는다. 암호화가 없어지면 그대로 쓴다.
- 함수 안의 코드는 고치지 않고 `GameMgr.Init` / `LangMgr.Init` / `UIMgr.Init`을 감싸기만 한다.
- 어디서든 실패하면 콘솔에 `[mjs-kr] disabled`를 남기고 원본을 그대로 넘긴다. 게임은 일본어로 정상 실행된다.

## 이미지 (실험 중)

글자가 박힌 이미지(이모티콘, 칭호, 로비, 이벤트 UI 등)는 한국 빌드(`/v4/kr/`)의 것으로 바꿔 보여준다.

**원칙: 번들 하나는 한국 서버와 똑같이 보이거나, 일본어 원본으로 보인다. 그 중간은 만들지 않는다.** KR 서버가 일부러 영어로 둔 이미지("ALL LAST" 등)도 그대로 둔다. 번역이 덜 되더라도 깨지지 않는 쪽을 고른다.

안전장치는 세 겹이다.

1. 짝 검증(`swap.js`): JP 클라이언트가 찾는 경로·스프라이트·노드 이름이 KR판에 다 있고, KR 전용 번들에 의존하지 않는 짝만 쓴다. 나머지는 일본어로 남는다.
2. 실행 중(`main.js`): KR 번들 받기 실패, 변환 오류, 크기 불일치가 나면 그 번들만 JP 원본을 준다. 매니페스트의 크기는 이미 스왑본 크기로 고쳐져 있지만 로더는 `fileSize`를 검사하지 않아서 JP 원본도 그대로 읽힌다(2026-11-06 `tools/smoke.js --break`로 확인).
3. 비상 스위치(`swapdb/overrides.json`의 `deny`): 이상한 번들을 넣고 `swap.json`만 다시 올리면 그 번들은 일본어로 돌아간다. 유저스크립트 업데이트는 필요 없다.

- 언어별 이미지는 `<폴더>/jp/<파일>`에 있고, C# 로더가 `client_language`(일섭은 항상 `jp`)로 폴더를 고른다. 그래서 게임은 계속 `jp` 경로를 요청한다.
- jp·kr 빌드는 같은 프로젝트에서 나와 번들 대부분이 같다. 번들 이름은 경로를 난독화한 것이라 `.../jp/...` 번들과 `.../kr/...` 번들이 짝지어진다.
- `swap.js`가 두 매니페스트에서 짝을 찾는다. 그다음 kr 번들의 번들 이름과 `kr` 토큰(`/kr/`, `_kr_` 등)을 `jp`로 바꾼다. 바꾼 결과가 jp 번들과 오브젝트 구성·이름이 같은 짝만 `public/swap.json`에 남긴다. 각 짝에는 kr 번들 이름과 바꾼 뒤의 크기가 들어간다. 바꾸는 문자열은 길이가 같아서 오프셋이 안 움직인다.
- 유저스크립트는 `swap.json`을 받아 매니페스트의 크기를 고치고, 게임이 그 jp 번들을 요청하면 kr 번들을 받아 같은 방식으로 바꿔서 준다. 실패하면 jp 원본을 준다.
- `swap.json`의 키는 해시가 붙은 전체 번들 이름이다. 게임이 업데이트되면 낡은 항목은 아무것에도 안 걸린다. `swap.js`는 `bundle_hash.txt`가 바뀌었을 때만 짝을 다시 검증한다.

### 스왑 원장 (`swapdb/`, 커밋한다)

- `builds/<날짜>_<jp해시8>_<kr해시8>.json`: 빌드 쌍마다 하나. 검증을 통과한 짝(`pairs`)과 떨어진 짝·이유(`rejected`). 빌드별 짝 기록이 여기 남는다.
- `verdicts.json`(선택): `"<jp번들> <kr번들>"`별 감사 결과(픽셀 → OCR). `tools/audit.py`가 쓴다. 배포에는 필요 없고, 있으면 `drop`만 반영한다. 나머지는 사람이 볼 참고 자료다. 번들 이름에 내용 해시가 있어서 한 번 판정한 짝은 판정 방식(`METHOD`)이 바뀌기 전까지 다시 보지 않는다.
  - `drop`: 픽셀이 같거나 JP가 찾는 이름의 이미지가 KR에 없다. 바꿔도 화면이 안 바뀌므로 `swap.json`에서 뺀다.
  - `swap`: 이미지가 다르다(번역). 글자 스프라이트는 번역되면 크기·모양이 통째로 바뀌는 게 정상이다.
  - `flag`: 사람이 볼 만하다. 이유는 `reasons`에 있다. 그대로 내보낸다. KR 서버의 디자인인 경우가 대부분이다.
    - `colors`: 색 분포가 크게 다르다(빠진 도장, 단순 리디자인이 섞여 있다).
    - `english`: OCR로 KR 이미지에서 JP에 없는 영어 단어를 확실하게 읽었고, 한글과 저작권 표기는 없다. KR 빌드에 영어 placeholder가 들어 있는 이미지가 있다. 장식 글꼴은 OCR이 잘 못 읽어서 안 걸렸다고 안심할 수는 없다. 이전 빌드에 없던 짝에 이 플래그가 붙으면 보류한다(아래 `hold.json`).
  - 항목마다 크기·dHash·변화량·팔레트 겹침·OCR 결과를 지문으로 남긴다.
- `overrides.json`: 사람이 내린 결정. 키는 JP 매니페스트의 에셋 경로나 폴더(`MyAssets/ui/entrance/pic/jp`)라서 번들 이름이 바뀌어도 유지되고 읽을 수 있다. 그 경로나 그 아래 에셋을 가진 JP 번들 전부에 걸린다. 예전 키(해시를 뗀 번들 이름, `bundleStem`)도 먹고, `node tools/overrides.js migrate`가 경로 키로 바꾼다.
  - `deny`: `{ "<경로>": "이유" }`. 번들 전체를 JP 원본으로 둔다.
  - `accept`: `{ "<경로>": { "<항목>": "<KR dHash>" } }`. 본 뒤 괜찮다고 한 감사 플래그. KR 이미지 모양(dHash 6비트 이내)이 그대로인 동안만 효력이 있어서, 다시 그려지면 또 알린다.
  - `node tools/overrides.js`(목록·이번 빌드에 걸리는 번들 수), `deny KEY 이유`, `accept KEY [항목…]`(지금 플래그된 항목을 지금 모양으로 받아들임).
- `hold.json`(생성물): 이전 빌드에 없던 짝인데 `english` 플래그가 `accept`로 풀리지 않은 것. JP로 두고 다음 빌드에서도 계속 보류한다. `accept`나 `deny`로 끝낸다.
- `public/swap.json` = 최신 스냅샷의 `pairs` − `drop` − `deny` − 보류. `v`(형식 버전)와 `min`(읽을 수 있는 최소 스크립트 버전)이 붙는다. 0.2.2부터 유저스크립트는 모르는 `v`이거나 자기 버전이 `min`보다 낮으면 이미지 스왑만 끈다(텍스트는 그대로). 항목 모양을 바꿀 때는 `swap.js`의 `SWAP_FORMAT`·`MIN_SCRIPT`를 올린다.
- KR 아틀라스에 없는 JP 스프라이트(JP 한정 항목)는 JP 페이지를 덧붙여 살린다(`mergeJpSprites`). 이 덧붙이기가 유일하게 "오류 없이 이상하게 보일" 수 있는 곳이다. 문제가 보이면 그 번들부터 `deny`한다.

```bash
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt   # + tesseract (apt install tesseract-ocr)
npm run deploy                                   # 검증 → swap.json → 빌드 → 배포 (Python 불필요)
npm run audit && node swap.js                    # (선택) 감사해서 drop 반영
.venv/bin/python tools/audit.py --dump /tmp/flag  # flag 항목의 jp/kr 이미지를 꺼내 보기
```
- 한국판이 없는 것(일섭 한정 이벤트·콜라보)과, kr판 구조가 달라 검증에서 떨어진 것(대국 이펙트 프리팹 등)은 일본어로 남는다.

## 자동 감시 (오라클 + 집 PC)

- 오라클(`diphy-oci`)의 `mjskr-watch.timer`가 15분마다 jp·kr `bundle_hash.txt`를 본다. 바뀌면 `tools/watch.js`가 매니페스트와 언어 번들을 `~/mjskr-archive`에 보관하고, jp 빌드에 `tools/canary.js`를 돌린 뒤 `queue/`에 작업을 넣는다.
- 집 PC의 `mjskr-worker.timer`(사용자 유닛)가 10분마다 큐를 확인한다. 작업이 있으면 `tools/worker.sh`가 번들을 받아 canary → 짝 검증 → 감사 → 이미지 색인(`tools/imgindex.py`) → 드리프트 리포트(`tools/drift.js`) → 게이트(`tools/gate.js`)를 돌리고 결과를 오라클에 올린 뒤 데스크톱 알림을 띄운다. 커밋은 하지 않는다.
- canary: 텍스트 패치가 기대는 것을 브라우저 없이 확인한다. 매니페스트가 읽히는지, `GameMgr.lua`를 찾아 풀고 `inject.lua`로 패치·복원되는지, `inject.lua`가 감싸는 `GameMgr.Init`·`LangMgr.Init`·`UIMgr.Init`과 `prefer_language`·`is_alphabet_lang` 등이 그대로인지, `fonts/kr/kr.ttf`가 있는지. 풀어 본 Lua는 `lua/<모듈>/<sha8>.lua`로 남고, 바뀌면 리포트에 diff가 붙는다.
- 게이트: 통과해야 `swap.json`을 사람 확인 없이 올려도 된다. `swap.json`이 지금 CDN 빌드용인지, 거기 적힌 KR 번들이 CDN에 다 있는지(HEAD), canary 통과, 리포트에 구조 개편 신호(짝 절반 이상 소실, JP 언어 번들 대량 소실, localizedImg 커버리지 급락)가 없는지, `src`·`public` 등이 커밋된 상태인지. 플래그·보류·새 거부·맞는 데 없는 override는 막지 않는다(리포트에만).
- 배포: 기본은 알림만("게시 가능" / "게시 안 함"과 이유). `~/.config/mjskr-worker.env`에 `MJSKR_AUTODEPLOY=1`을 넣으면 게이트 통과 시 `npx wrangler deploy`까지 하고 오라클 `published.jsonl`에 남긴다.
- 보관소(`~/mjskr-archive`, 집 PC에는 `.cache/archive`로 미러):
  - `builds.jsonl`: 빌드 변경 기록. `manifests/<lang>/<hash>.majset`: 빌드별 매니페스트.
  - `ab/<lang>/<번들>`: 언어 번들 원본. 이름에 해시가 있어 덮어쓰지 않고 쌓인다.
  - `img/<sha>.png`: 이미지마다 한 장씩. `index/<lang>/<번들>.json`: 번들의 경로와 이미지별 크기·dHash·sha1.
  - `reports/`: 빌드별 드리프트 리포트(`.md`, 게이트용 `.json`). `swapjson/`: 빌드별로 만든 `swap.json`. `swapdb/`: 원장 사본.
  - `canary/<jp해시>.json`, `lua/<모듈>/<sha8>.lua`: canary 결과와 풀어 본 Lua. `published.jsonl`: 자동 배포 기록.
- 드리프트 리포트는 짝의 유지·갱신·신규·사라짐·새 거부를 나누고, 이미지로 역추적한다. 사라진 JP 번들과 새 번들이 같은 픽셀(또는 같은 dHash)을 가지면 경로 이동으로 보고, 맞는 데가 없어진 `deny`·`accept` 항목도 옮겨 간 곳을 제안한다. 보류 목록과 옛 stem 키도 알려 준다. 고치는 건 사람이 한다.
- 언어 규칙 교차검증(`tools/langcheck.js`): 게임의 `MyAssets/docs/localizedImg_jp.json`은 로더가 언어별로 바꾸는 이미지 목록이다. `fileType` 1인 `a/b/c.png`는 `a/b/jp/c.png`(또는 `a/b/jp/` 아틀라스의 스프라이트)를 뜻한다. 이걸 정답지로 삼아 jp 폴더로 풀리는 비율과, 그중 짝 있는 번들에 든 비율을 잰다. 풀리는 비율이 절반 아래로 떨어지거나(폴더 규칙 변경) 짝 커버리지가 이전 빌드의 70% 아래로 떨어지면 게시를 막는다. 짝 없는 번들은 이유별로 나눈다: KR에 kr판 없음(일섭 전용, 정상), 검증 탈락, KR 쪽 번들 구성이 다름(1:1 짝이 안 되는 것).
- 스모크 테스트(`tools/smoke.js`, `npm run smoke`): 진짜 `game.mahjongsoul.com`을 Chrome(헤드리스)으로 열고 `public/mahjongsoulKR.user.js`를 문서 시작 시점에 넣는다. `swap.json`은 배포본 대신 `public/swap.json`을 쓴다. 타이틀 화면까지만 보고 로그인은 안 한다. 통과 조건은 훅 설치, `GameMgr.lua` 패치, `prefer_language=kr`, 매니페스트와 `swap.json`이 전부 맞음(`n/n`), 스왑 1개 이상, 스왑 실패 0, 페이지 오류 0이다. 스크린샷과 콘솔 로그가 남는다. 게임 캐시를 살리려고 `.cache/smoke-profile`을 계속 쓴다(처음 ~2분, 그다음 ~40초).
  - `--break N`: 타이틀이 읽는 번들 N개의 KR 이름을 일부러 망가뜨려 JP 원본 폴백이 깨지지 않는지 본다.
  - 워커는 게이트를 통과하면 이걸 돌리고, 실패하면 "게시 안 함"으로 바꾼다(`MJSKR_SMOKE=0`이면 건너뜀). 결과는 보관소 `smoke/<스냅샷>/`.
  - `swap.json`은 `data:` URL로 넣는다. 게임이 서비스 워커 없이는 안 뜨는데, 서비스 워커를 거치는 요청은 Playwright `route`로 못 바꾼다.
- 설치·갱신: `npm i`(playwright-core, Chrome은 설치된 것을 씀), `tools/oracle_install.sh`(오라클 코드·유닛), `cp tools/systemd/home/mjskr-worker.* ~/.config/systemd/user/ && systemctl --user enable --now mjskr-worker.timer`.
- 수동 실행: `tools/worker.sh --force`. 실패하면 한 시간 쉬었다가 다시 한다(`.cache/worker.failed`).

## 파일

```
src/core.js       UnityFS·SerializedFile·TextAsset 읽기/쓰기, LZ4, XOR 키 찾기
src/main.js       브라우저 쪽: fetch 후킹
src/inject.lua    게임 Lua에 덧붙이는 코드
build.js          src → public/mahjongsoulKR.user.js
swap.js           jp·kr 매니페스트 → swapdb/builds 스냅샷 → public/swap.json (커밋하지 않음)
tools/audit.py    짝의 이미지를 디코드해 비교 → swapdb/verdicts.json
tools/watch.js    (오라클) 빌드 감시·번들 보관·큐
tools/worker.sh   (집 PC) 큐 처리: 검증·감사·색인·리포트
tools/imgindex.py 보관한 번들의 이미지 색인·저장
tools/drift.js    이전 빌드와 비교, 이미지로 이동 역추적
tools/canary.js   텍스트 패치가 기대는 Lua·매니페스트·폰트 확인
tools/gate.js     swap.json을 사람 확인 없이 올려도 되는지
tools/overrides.js swapdb/overrides.json 읽기·편집(deny·accept, 경로 키)
tools/langcheck.js localizedImg_jp.json과 짝 규칙 교차검증
tools/smoke.js    실제 게임 타이틀까지 띄워 보는 스모크 테스트 (Chrome)
swapdb/           빌드별 짝 기록, 감사 결과, 수동 결정
public/           jakhon.chamchi.me에 올라가는 파일 (index.html = 설치 안내)
wrangler.jsonc    Cloudflare 배포 설정
```

## 고치고 올리기

```bash
# package.json의 version을 올린 뒤
npm run deploy
```

- `node swap.js`로 `public/swap.json`을 만들고(빌드가 그대로면 검증은 건너뜀), `node build.js`로 `public/mahjongsoulKR.user.js`를 만든 다음 `npx wrangler deploy`로 jakhon.chamchi.me에 올린다.
- 게임 빌드만 바뀌었을 때는 버전을 안 올려도 된다. `swap.json`만 새로 올리면 된다.
- Tampermonkey는 `@updateURL`(jakhon.chamchi.me)에서 버전을 비교해 자동 업데이트한다. 그래서 **버전을 올려야** 사용자에게 반영된다.
- 로그인이 풀렸으면 `npx wrangler login`.
