import { useState } from 'react';
import { request } from './api';
import { Message, useAction } from './ui';
import './verification.css';

const explanations = {
  valid: 'Integrity valid. The signed snapshot matches the record checked by EduVerify at the time below.',
  invalid: 'Invalid artifact. Its format, signature, signing key or issuance record could not be validated.',
  expired: 'Expired artifact. Integrity is valid, but its 24-hour validity period has ended. Request a new artifact.',
  revoked: 'Revoked artifact. Integrity is valid, but the issuer institution has withdrawn this artifact.',
  outdated: 'Outdated artifact. Integrity is valid, but the source record was changed or is no longer available.',
};
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const issuedShape = data => uuid(data.artifactId) && uuid(data.revision)
  && typeof data.issuer === 'string' && typeof data.payload === 'string' && data.payload.length <= 2048
  && typeof data.issuedAt === 'string' && typeof data.expiresAt === 'string'
  && typeof data.qrDataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qrDataUrl)
  && data.officialApaarAuthenticity === 'not_verified';
const resultShape = data => {
  const expected = { valid: [true, true], invalid: [false, null], expired: [true, null],
    revoked: [true, null], outdated: [true, false] };
  return Object.hasOwn(expected, data.status)
    && data.integrityValid === expected[data.status][0]
    && data.recordCurrent === expected[data.status][1]
    && typeof data.checkedAt === 'string' && data.officialApaarAuthenticity === 'not_verified';
};

export function IssueArtifact({ studentId }) {
  const [artifact, setArtifact] = useState(null);
  const [revoked, setRevoked] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const action = useAction();
  async function issue() {
    await action.run(async () => {
      setArtifact(null); setRevoked(false); setConfirm(false);
      setArtifact(await request('/v1/verification/issue', {
        method: 'POST', body: { studentId }, validate: issuedShape,
      }));
    });
  }
  async function revoke() {
    await action.run(async () => {
      await request('/v1/verification/revoke', {
        method: 'POST', body: { artifactId: artifact.artifactId }, validate: d => d.status === 'revoked',
      });
      setRevoked(true); setConfirm(false);
    });
  }
  return <section aria-label="Artifact issuance">
    <h3>EduVerify QR artifact</h3>
    <p>Issue for an active, valid, nonduplicate record. This attests to an EduVerify snapshot; it does not certify compliance or official APAAR authenticity.</p>
    <button disabled={action.busy} onClick={issue}>{action.busy ? 'Processing artifact…' : 'Issue QR artifact'}</button>
    {action.error && <Message error>{action.error} Check the current state before retrying.</Message>}
    {artifact && <>
      <Message>{revoked ? 'Artifact revoked. Do not share this QR.' : 'Artifact issued and saved by the server.'}</Message>
      <dl><dt>Artifact</dt><dd>{artifact.artifactId}</dd><dt>Issuer</dt><dd>{artifact.issuer}</dd><dt>Snapshot revision</dt><dd>{artifact.revision}</dd><dt>Issued</dt><dd>{artifact.issuedAt}</dd><dt>Expires</dt><dd>{artifact.expiresAt}</dd></dl>
      {!revoked && <><img className="qr-image" src={artifact.qrDataUrl} alt="EduVerify signed artifact QR code" width="420" height="420" />
        <p><a href={artifact.qrDataUrl} download={`eduverify-${artifact.artifactId}.png`}>Download QR PNG</a></p>
        <label>Signed QR payload (copy as text)<textarea readOnly value={artifact.payload} rows={5} spellCheck={false} /></label>
        {!confirm ? <button disabled={action.busy} onClick={() => setConfirm(true)}>Revoke this artifact</button>
          : <div className="notice"><p>Confirm revocation? This artifact cannot be reactivated.</p><div className="actions"><button disabled={action.busy} onClick={revoke}>Confirm revocation</button><button disabled={action.busy} onClick={() => setConfirm(false)}>Cancel revocation</button></div></div>}
      </>}
    </>}
  </section>;
}

export function VerifyArtifact() {
  const [payload, setPayload] = useState('');
  const [result, setResult] = useState(null);
  const action = useAction();
  async function submit(event) {
    event.preventDefault();
    await action.run(async () => {
      setResult(null);
      if (!payload.trim() || new TextEncoder().encode(payload.trim()).length > 2048) throw new Error('Enter a signed payload of at most 2048 UTF-8 bytes.');
      setResult(await request('/v1/verification/verify', { method: 'POST', body: { payload: payload.trim() }, validate: resultShape }));
    });
  }
  return <section>
    <h2>Verify an EduVerify artifact</h2>
    <p>Public status check. Paste the signed QR text only, never a student name, APAAR ID or full record. The payload is sent to the local Express service and stays out of URLs and browser storage.</p>
    <form onSubmit={submit}><fieldset disabled={action.busy}>
      <label>QR payload<textarea maxLength={2048} value={payload} onChange={e => { setPayload(e.target.value); setResult(null); }} rows={7} spellCheck={false} autoComplete="off" /></label>
      <button>{action.busy ? 'Checking artifact…' : 'Verify artifact'}</button>
    </fieldset></form>
    {action.error && <Message error>Verification could not be completed. {action.error} No valid result has been assigned.</Message>}
    {result && <div role="status" className={`notice ${result.status === 'valid' ? '' : 'error'}`}>
      <h3>Artifact status: {result.status}</h3><p>{explanations[result.status]}</p>
      <p>Signature/integrity: {result.integrityValid ? 'valid' : 'not validated'}. Record current: {result.recordCurrent === null ? 'not established' : result.recordCurrent ? 'yes, at check time' : 'no'}.</p>
      <p>Checked: {result.checkedAt}</p>
    </div>}
    <p>This verifies an EduVerify-issued artifact. It does not prove identity, official APAAR authenticity, source-data correctness or regulatory approval. A QR can be copied; possession does not identify the presenter.</p>
    <p>Payload entry is supported. Camera scanning and image decoding are not implemented in this prototype.</p>
  </section>;
}
