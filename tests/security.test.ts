import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isAllowedOrigin,
  mapSafeServerError,
  sanitizeCsvCell,
  sanitizeTextInput,
  SlidingWindowRateLimiter,
  validateConsultPayload,
} from '../src/utils/security.ts';

describe('Security Utilities — CSV Injection, Input Validation, Rate Limiting & Origin Checks', () => {
  it('neutralizes dangerous spreadsheet formula prefixes (CWE-1236) and escapes quotes', () => {
    assert.equal(sanitizeCsvCell('=1+1'), `"'=1+1"`);
    assert.equal(sanitizeCsvCell('+SUM(A1:A2)'), `"'+SUM(A1:A2)"`);
    assert.equal(sanitizeCsvCell('-2+3'), `"'-2+3"`);
    assert.equal(sanitizeCsvCell('@SUM(1,2)'), `"'@SUM(1,2)"`);
    assert.equal(sanitizeCsvCell('  =cmd|"/c calc"!A0'), `"'  =cmd|""/c calc""!A0"`);
    assert.equal(sanitizeCsvCell('\t=1+1'), `"'\t=1+1"`);
    assert.equal(sanitizeCsvCell('Normal "Firm" Name'), `"Normal ""Firm"" Name"`);
    assert.equal(sanitizeCsvCell(null), '""');
  });

  it('strips control characters and enforces max length on free text', () => {
    const dirty = '  Hello\u0000\u0007World  ';
    assert.equal(sanitizeTextInput(dirty, 50), 'HelloWorld');
    assert.equal(sanitizeTextInput('abcdef', 3), 'abc');
    assert.equal(sanitizeTextInput(12345 as unknown), '');
  });

  it('validates /api/quant/consult payloads strictly', () => {
    assert.equal(validateConsultPayload(null).ok, false);
    assert.equal(validateConsultPayload({ messages: [] }).ok, false);
    assert.equal(
      validateConsultPayload({
        messages: [{ role: 'assistant', content: 'last must be user' }],
      }).ok,
      false
    );
    assert.equal(
      validateConsultPayload({
        messages: [{ role: 'user', content: 'ok' }],
        intent: 'INVALID',
      }).ok,
      false
    );
    assert.equal(
      validateConsultPayload({
        messages: [{ role: 'user', content: 'ok' }],
        workspaceContext: { giant: 'x'.repeat(40000) },
      }).ok,
      false
    );

    const valid = validateConsultPayload({
      messages: [{ role: 'user', content: '  Analise meu fator F  ' }],
      intent: 'A',
      workspaceContext: { fatorHedgeF: 1.124 },
    });
    assert.equal(valid.ok, true);
    assert.equal(valid.messages?.[0].content, 'Analise meu fator F');
    assert.equal(valid.intent, 'A');
  });

  it('enforces sliding window rate limits and resets after window expiration', () => {
    const limiter = new SlidingWindowRateLimiter(2, 10_000, 100);
    const t0 = 1_000_000;
    assert.equal(limiter.check('1.2.3.4', t0).allowed, true);
    assert.equal(limiter.check('1.2.3.4', t0 + 1000).allowed, true);

    const blocked = limiter.check('1.2.3.4', t0 + 2000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds >= 8);

    // After window passes, requests are allowed again
    assert.equal(limiter.check('1.2.3.4', t0 + 11_000).allowed, true);
  });

  it('validates allowed origins and rejects untrusted cross-origin callers', () => {
    assert.equal(isAllowedOrigin(undefined, 'localhost:3000', undefined), true);
    assert.equal(isAllowedOrigin('http://localhost:3000', 'localhost:3000', undefined), true);
    assert.equal(
      isAllowedOrigin('https://app.example.com', 'other.example.com', 'https://app.example.com'),
      true
    );
    assert.equal(
      isAllowedOrigin('https://evil.attacker.com', 'app.example.com', 'https://app.example.com'),
      false
    );
    assert.equal(isAllowedOrigin('not-a-valid-url', 'app.example.com', undefined), false);
  });

  it('maps internal server exceptions to safe public messages without leaking secrets', () => {
    const authErr = mapSafeServerError(new Error('API_KEY_INVALID: AIzaSySecretKey12345'));
    assert.equal(authErr.status, 502);
    assert.equal(authErr.publicMessage.includes('AIzaSySecretKey12345'), false);

    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    assert.equal(mapSafeServerError(abortErr).status, 504);

    const rateErr = mapSafeServerError(new Error('429 RESOURCE_EXHAUSTED'));
    assert.equal(rateErr.status, 429);
  });
});
