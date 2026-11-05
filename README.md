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

## 파일

```
src/core.js       UnityFS·SerializedFile·TextAsset 읽기/쓰기, LZ4, XOR 키 찾기
src/main.js       브라우저 쪽: fetch 후킹
src/inject.lua    게임 Lua에 덧붙이는 코드
build.js          src → public/mahjongsoulKR.user.js
public/           jakhon.chamchi.me에 올라가는 파일 (index.html = 설치 안내)
wrangler.jsonc    Cloudflare 배포 설정
```

## 고치고 올리기

```bash
# package.json의 version을 올린 뒤
npm run deploy
```

- `node build.js`로 `public/mahjongsoulKR.user.js`를 만든 다음 `npx wrangler deploy`로 jakhon.chamchi.me에 올린다.
- Tampermonkey는 `@updateURL`(jakhon.chamchi.me)에서 버전을 비교해 자동 업데이트한다. 그래서 **버전을 올려야** 사용자에게 반영된다.
- 로그인이 풀렸으면 `npx wrangler login`.
