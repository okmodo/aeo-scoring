import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, publicEncrypt, createCipheriv, constants } from 'node:crypto';
import { decryptEnvelope, filterTelemetry, cpuTime, validCpu } from './operator-run.mjs';

test('decrypts the WebCrypto-compatible RSA-OAEP and AES-GCM envelope', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = randomBytes(32), iv = randomBytes(12), plaintext = { secret: 'private', tailUrl: 'wss://example.com/?secret=private' };
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext)), cipher.final(), cipher.getAuthTag()]);
  const envelope = { wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') };
  assert.deepEqual(decryptEnvelope(envelope, privateKey), plaintext);
  ciphertext[0] ^= 1;
  assert.throws(() => decryptEnvelope({ ...envelope, ciphertext: ciphertext.toString('base64') }, privateKey));
});

test('telemetry strips headers, query strings and logs while retaining zero CPU', () => {
  const filtered = filterTelemetry({ cpuTime: 0, event: { request: { url: 'https://example.com/control?secret=private', headers: { authorization: 'private' } }, nested: { outcome: 'ok' } }, logs: [{ message: 'private' }] });
  assert.deepEqual(filtered.paths, ['/control']);
  assert.equal(cpuTime(filtered), 0);
  assert.equal(JSON.stringify(filtered).includes('private'), false);
  assert.deepEqual(filtered.keys, ['cpuTime', 'event', 'logs']);
});


test('CPU gate requires finite nonnegative telemetry within the limit', () => {
  const telemetry = value => ({ values: [{ key: 'cpuTime', fieldPath: 'cpuTime', value }] });
  assert.equal(validCpu(telemetry(0), 1000), true);
  assert.equal(validCpu(telemetry(1000), 1000), true);
  for (const value of [-1, NaN, Infinity, 1001]) assert.equal(validCpu(telemetry(value), 1000), false);
  assert.equal(validCpu({ values: [] }, 1000), false);
});


test('nested CPU cannot satisfy the primary event gate', () => {
  const nested = filterTelemetry({ event: { request: { cf: { cpuTimeMs: 1 } }, child: { cpuTime: 1 } } });
  assert.equal(validCpu(nested, 1000), false);
  assert.equal(validCpu(filterTelemetry({ $workers: { cpuTimeMs: 0 } }), 1000), true);
  assert.equal(validCpu(filterTelemetry({ $workers: { cpuTime: 0 } }), 1000), false);
});
