const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { BrowserCertificates, parseCertificateRequest } = require('../dist/agent/certificates.js');
const { BrowserDialogs } = require('../dist/agent/dialogs.js');
const { BrowserControl } = require('../dist/agent/control.js');

function certificate(directory, name) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, name + '.key'), '-out', join(directory, name + '.pem'), '-days', '1', '-subj', '/CN=fixture.invalid'], { stdio: 'ignore' });
  return { data: readFileSync(join(directory, name + '.pem'), 'utf8'), subjectName: 'fixture.invalid', issuerName: 'fixture.invalid', validStart: 0, validExpiry: 1 };
}

test('certificate decisions bind to context, origin, DER SHA-256, epoch, and explicit approval', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tb-cert-unit-'));
  try {
    const first = certificate(directory, 'first');
    const second = certificate(directory, 'second');
    const contents = new EventEmitter();
    contents.debugger = new EventEmitter();
    contents.getURL = () => 'about:blank';
    const control = new BrowserControl();
    const dialogs = new BrowserDialogs(contents, async () => ({}), 50);
    dialogs.configure(7, control);
    const certificates = new BrowserCertificates(contents, dialogs);
    const origin = 'https://fixture.invalid:8443';
    const emit = (url, cert = first, mainFrame = true) => {
      const results = [];
      contents.emit('certificate-error', { preventDefault() {} }, url, 'ERR_CERT_AUTHORITY_INVALID', cert, trusted => results.push(trusted), mainFrame);
      return results;
    };
    const blocked = emit(origin + '/');
    const pending = dialogs.pending;
    assert.equal(pending.type, 'certificate');
    assert.equal(pending.certificate.origin, origin);
    assert.match(pending.certificate.fingerprint, /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
    assert.deepEqual(blocked, [], 'request remains blocked pending explicit decision');
    const decision = { action: 'approve', dialogId: pending.id, origin, fingerprint: pending.certificate.fingerprint };
    await assert.rejects(dialogs.respond({ dialogId: pending.id, accept: true, expectedControlEpoch: 1 }), /exact origin/);
    await assert.rejects(certificates.decide({ ...decision, origin: 'https://fixture.invalid:9443' }, 1), /mismatched/);
    control.takeHuman('keyboard');
    await assert.rejects(certificates.decide(decision, 1), /stale/);
    control.resume(control.controlEpoch);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(certificates.decide(decision, control.controlEpoch, abort.signal));
    assert.deepEqual(blocked, []);
    await certificates.decide(decision, control.controlEpoch);
    assert.deepEqual(blocked, [true]);
    assert.deepEqual(emit(origin + '/other', first, false), [true], 'same-origin resources use only the approved certificate');
    const otherPort = emit('https://fixture.invalid:9443/');
    await dialogs.cancel();
    assert.deepEqual(otherPort, [false]);
    const changed = emit(origin + '/', second);
    assert.notEqual(dialogs.pending.certificate.fingerprint, decision.fingerprint);
    await dialogs.cancel();
    assert.deepEqual(changed, [false]);
    certificates.revoke(decision);
    assert.equal(certificates.status().exceptions.length, 0);
    const revoked = emit(origin + '/');
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.deepEqual(revoked, [false], 'timeout never grants trust');
    const resource = emit(origin + '/resource', first, false);
    assert.equal(dialogs.pending.canAccept, false, 'unapproved subresources cannot grant a context exception');
    await dialogs.cancel();
    assert.deepEqual(resource, [false]);
    certificates.dispose(); dialogs.dispose();
    assert.throws(() => parseCertificateRequest('revoke', undefined, origin + '/', decision.fingerprint), /exact HTTPS origin/);
    const userinfo = new URL('https://fixture.invalid');
    userinfo.username = 'fixture'; userinfo.password = 'sample';
    assert.throws(() => parseCertificateRequest('approve', 'id', userinfo.href, decision.fingerprint), /exact HTTPS origin/);
    assert.throws(() => parseCertificateRequest('approve', 'id', origin, 'AA'), /SHA-256/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
