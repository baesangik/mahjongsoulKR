// node build.js -> public/mahjongsoulKR.user.js
const fs = require('fs');
const path = require('path');
const here = p => path.join(__dirname, p);

const { version } = require('./package.json');
const SITE = 'https://jakhon.chamchi.me';
const REPO = 'https://github.com/baesangik/mahjongsoulKR';

const header = `// ==UserScript==
// @name         mahjongsoulKR
// @namespace    https://jakhon.chamchi.me
// @version      ${version}
// @description  일본 서버 작혼(웹)의 텍스트를 게임에 내장된 한국어로 표시합니다 (비공식)
// @icon         ${SITE}/icon.png
// @homepageURL  ${SITE}
// @supportURL   ${REPO}/issues
// @updateURL    ${SITE}/mahjongsoulKR.user.js
// @downloadURL  ${SITE}/mahjongsoulKR.user.js
// @match        https://game.mahjongsoul.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
`;

const lua = fs.readFileSync(here('src/inject.lua'), 'utf8');
const out = [
  header,
  `const MJS_KR_LUA = ${JSON.stringify(lua)};`,
  `const MJS_KR_VERSION = ${JSON.stringify(version)};`,
  fs.readFileSync(here('src/core.js'), 'utf8').replace(/\nif \(typeof module[^\n]*\n?$/, '\n'),
  fs.readFileSync(here('src/main.js'), 'utf8'),
].join('\n');
fs.writeFileSync(here('public/mahjongsoulKR.user.js'), out);
fs.writeFileSync(here('public/version.txt'), version + '\n');
console.log(`wrote public/mahjongsoulKR.user.js v${version} (${out.length} bytes)`);
