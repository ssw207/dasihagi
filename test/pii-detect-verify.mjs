/**
 * 개인정보(PII) 자동 감지 모듈 검증 스크립트
 *
 * 브라우저 없이 mock DOM을 구성해 pii-detect.js의 isSensitive() 판정을 검증한다.
 * 감지 소스: toss/slash, ko-pii, kordoc, Bitwarden, validator.js, Braintree
 *
 * 실행: node --experimental-default-type=module test/pii-detect-verify.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
// 1. mock DOM (pii-detect.js가 요구하는 최소 환경)
// ============================================================

class MockElement {
  constructor(attrs = {}) {
    this.attrs = { ...attrs };
    this.type = attrs.type || '';
    this.checked = !!attrs.checked;
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  get labels() {
    return this.attrs._labels || [];
  }
  closest() {
    return this.attrs._parentLabel || null;
  }
}

class MockInputElement extends MockElement {}

globalThis.Element = MockElement;
globalThis.HTMLInputElement = MockInputElement;
globalThis.CSS = { escape: (s) => String(s) };
globalThis.document = { querySelector: () => null };
globalThis.window = {};

// ============================================================
// 2. pii-detect.js 로드 (IIFE가 window.PiiDetect에 할당)
// ============================================================

const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pii-detect.js');
eval(fs.readFileSync(modulePath, 'utf8'));
const { isSensitive } = window.PiiDetect;

// ============================================================
// 3. 검증
// ============================================================

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    fail++;
    console.log('  ❌ ' + name + ' — 기대: ' + expected + ', 실제: ' + actual);
  }
}

console.log('\n[메타데이터 감지]');
check('type=password → 민감', isSensitive(new MockInputElement({ type: 'password' }), 'abc123'), true);
check('placeholder="이름" → 민감', isSensitive(new MockElement({ placeholder: '이름' }), ''), true);
check('aria-label="주소" → 민감', isSensitive(new MockElement({ 'aria-label': '주소' }), ''), true);
check('name="user_email" → 민감', isSensitive(new MockElement({ name: 'user_email' }), ''), true);
check('placeholder="휴대폰 번호" → 민감', isSensitive(new MockElement({ placeholder: '휴대폰 번호' }), ''), true);
check('autocomplete="cc-number" → 민감', isSensitive(new MockElement({ autocomplete: 'cc-number' }), ''), true);
check('autocomplete="off" → 미민감', isSensitive(new MockElement({ autocomplete: 'off' }), 'abc'), false);
check('name="search" → 미민감', isSensitive(new MockElement({ name: 'search' }), 'abc'), false);
check('name="q" → 미민감', isSensitive(new MockElement({ name: 'q' }), 'phone'), false);
check('label 텍스트 "생년월일" → 민감', isSensitive(new MockElement({ _labels: [{ textContent: '생년월일' }] }), ''), true);

console.log('\n[값 정규식 감지]');
check('값 "010-1234-5678" → 민감', isSensitive(new MockElement({}), '010-1234-5678'), true);
check('값 "01012345678" → 민감', isSensitive(new MockElement({}), '01012345678'), true);
check('값 "+82-10-1234-5678" → 민감', isSensitive(new MockElement({}), '+82-10-1234-5678'), true);
check('값 "02-123-4567" → 민감', isSensitive(new MockElement({}), '02-123-4567'), true);
check('값 "hong@test.com" → 민감', isSensitive(new MockElement({}), 'hong@test.com'), true);
check('값 "900101-1234567" (주민번호, 날짜 유효) → 민감', isSensitive(new MockElement({}), '900101-1234567'), true);
check('값 "9001011234567" (무구분 주민번호) → 민감', isSensitive(new MockElement({}), '9001011234567'), true);
check('값 "999999-1234567" (날짜 무효) → 미민감', isSensitive(new MockElement({}), '999999-1234567'), false);
check('값 "220-81-62517" (사업자번호 체크섬) → 민감', isSensitive(new MockElement({}), '220-81-62517'), true);
check('값 "4111-1111-1111-1111" (카드 Luhn) → 민감', isSensitive(new MockElement({}), '4111-1111-1111-1111'), true);
check('값 "1234-5678-9012-3456" (Luhn 실패) → 미민감', isSensitive(new MockElement({}), '1234-5678-9012-3456'), false);
check('값 "12-34-123456-01" (운전면허 지역코드 12) → 민감', isSensitive(new MockElement({}), '12-34-123456-01'), true);
check('값 "01-01-123456-01" (지역코드 1, 무효) → 미민감', isSensitive(new MockElement({}), '01-01-123456-01'), false);
check('값 "M12345678" (여권) → 민감', isSensitive(new MockElement({}), 'M12345678'), true);

console.log('\n[오탐 방지]');
check('값 "안녕하세요" → 미민감', isSensitive(new MockElement({}), '안녕하세요'), false);
check('값 "2024-01-15" (날짜) → 미민감', isSensitive(new MockElement({}), '2024-01-15'), false);
check('값 "50" → 미민감', isSensitive(new MockElement({}), '50'), false);
check('값 "12345" (순수 5자리, 우편번호 신형 앵커 없음) → 미민감', isSensitive(new MockElement({}), '12345'), false);
check('값 "555-123-4567" (미국번호, 한국 패턴 아님) → 미민감', isSensitive(new MockElement({}), '555-123-4567'), false);
check('값 "" (빈 값) → 미민감', isSensitive(new MockElement({}), ''), false);

// ============================================================
// 4. 결과
// ============================================================

console.log('\n' + '='.repeat(50));
console.log('결과: ' + pass + ' PASS / ' + fail + ' FAIL');
if (fail > 0) process.exit(1);
console.log('모든 PII 감지 검증 통과');