import { describe, expect, it } from 'vitest';

import {
  RequestRejected,
  SignatureInvalid,
  sign,
  verifySignature,
  headerValue,
} from '@korsi/plugin';

const SECRET = 's3cret';
const BODY = '{"topic":"plugin.proposal.settled"}';

describe("Korsi's signature", () => {
  it('passes for Korsi’s own signature, as text or bytes', () => {
    verifySignature(SECRET, BODY, sign(SECRET, BODY, { now: 1000 }), { now: 1010 });
    verifySignature(SECRET, new TextEncoder().encode(BODY), sign(SECRET, BODY, { now: 1000 }), {
      now: 1010,
    });
  });

  it('is HMAC-SHA256 of "<t>.<body>" -- the same value the Python SDK pins', () => {
    expect(sign('k', '{}', { now: 1 })).toBe(
      't=1,v1=3dd49b2593d0f9a349e9e71c4bde3e2b862c2be4003fe9b4ba81332029310158'
    );
  });

  it('fails for another body, another secret, an old or a future stamp', () => {
    const header = sign(SECRET, BODY, { now: 1000 });
    expect(() => verifySignature(SECRET, `${BODY} `, header, { now: 1010 })).toThrow(/match/);
    expect(() => verifySignature('other', BODY, header, { now: 1010 })).toThrow(SignatureInvalid);
    expect(() => verifySignature(SECRET, BODY, header, { now: 1301 })).toThrow(/stale/);
    expect(() =>
      verifySignature(SECRET, BODY, sign(SECRET, BODY, { now: 2000 }), { now: 1000 })
    ).toThrow(/stale/);
  });

  it('answers 401 when there is none', () => {
    try {
      verifySignature(SECRET, BODY, undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RequestRejected);
      expect((error as RequestRejected).status).toBe(401);
    }
  });

  it.each(['garbage', 't=abc,v1=00', 'v1=00', 't=1000'])('refuses the malformed %s', (header) => {
    expect(() => verifySignature(SECRET, BODY, header, { now: 1000 })).toThrow(SignatureInvalid);
  });

  it('accepts any one of several v1, as a rotation sends', () => {
    const old = sign('old-secret', BODY, { now: 1000 }).split(',')[1];
    const both = `${sign(SECRET, BODY, { now: 1000 })},${old}`;
    verifySignature(SECRET, BODY, both, { now: 1000 });
    verifySignature('old-secret', BODY, both, { now: 1000 });
  });

  it('reads a header from Node, Fetch or a plain object', () => {
    expect(headerValue({ 'korsi-signature': 'a' }, 'Korsi-Signature')).toBe('a');
    expect(headerValue({ 'Korsi-Signature': ['b', 'c'] }, 'korsi-signature')).toBe('b');
    expect(headerValue(new Headers({ 'Korsi-Signature': 'd' }), 'korsi-signature')).toBe('d');
    expect(headerValue({}, 'korsi-signature')).toBeNull();
  });
});
