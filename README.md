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

- 언어별 이미지는 `<폴더>/jp/<파일>`에 있고, C# 로더가 `client_language`(일섭은 항상 `jp`)로 폴더를 고른다. 그래서 게임은 계속 `jp` 경로를 요청한다.
- jp·kr 빌드는 같은 프로젝트에서 나와 번들 대부분이 같다. 번들 이름은 경로를 난독화한 것이라 `.../jp/...` 번들과 `.../kr/...` 번들이 짝지어진다.
- `swap.js`가 두 매니페스트에서 짝을 찾는다. 그다음 kr 번들의 번들 이름과 `kr` 토큰(`/kr/`, `_kr_` 등)을 `jp`로 바꾼다. 바꾼 결과가 jp 번들과 오브젝트 구성·이름이 같은 짝만 `public/swap.json`에 남긴다. 각 짝에는 kr 번들 이름과 바꾼 뒤의 크기가 들어간다. 바꾸는 문자열은 길이가 같아서 오프셋이 안 움직인다.
- 유저스크립트는 `swap.json`을 받아 매니페스트의 크기를 고치고, 게임이 그 jp 번들을 요청하면 kr 번들을 받아 같은 방식으로 바꿔서 준다. 실패하면 jp 원본을 준다.
- `swap.json`의 키는 해시가 붙은 전체 번들 이름이다. 게임이 업데이트되면 낡은 항목은 아무것에도 안 걸린다. `swap.js`는 `bundle_hash.txt`가 바뀌었을 때만 다시 돈다.
- 한국판이 없는 것(일섭 한정 이벤트·콜라보)과, kr판 구조가 달라 검증에서 떨어진 것(대국 이펙트 프리팹 등)은 일본어로 남는다.

## 파일

```
src/core.js       UnityFS·SerializedFile·TextAsset 읽기/쓰기, LZ4, XOR 키 찾기
src/main.js       브라우저 쪽: fetch 후킹
src/inject.lua    게임 Lua에 덧붙이는 코드
build.js          src → public/mahjongsoulKR.user.js
swap.js           jp·kr 매니페스트 → public/swap.json (이미지 번들 짝, 커밋하지 않음)
public/           jakhon.chamchi.me에 올라가는 파일 (index.html = 설치 안내)
wrangler.jsonc    Cloudflare 배포 설정
```

## 고치고 올리기

```bash
# package.json의 version을 올린 뒤
npm run deploy
```

- `node swap.js`로 `public/swap.json`을 만들고(빌드가 그대로면 건너뜀), `node build.js`로 `public/mahjongsoulKR.user.js`를 만든 다음 `npx wrangler deploy`로 jakhon.chamchi.me에 올린다.
- 게임 빌드만 바뀌었을 때는 버전을 안 올려도 된다. `swap.json`만 새로 올리면 된다.
- Tampermonkey는 `@updateURL`(jakhon.chamchi.me)에서 버전을 비교해 자동 업데이트한다. 그래서 **버전을 올려야** 사용자에게 반영된다.
- 로그인이 풀렸으면 `npx wrangler login`.
