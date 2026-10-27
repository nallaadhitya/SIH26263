import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IssueArtifact, VerifyArtifact } from '../Verification';
import App from '../App';
import { clearSession, setSessionHandler } from '../api';

const id = '11111111-1111-4111-8111-111111111111';
const artifact = { artifactId: id, revision: '22222222-2222-4222-8222-222222222222', issuer: 'eduverify-local',
  issuedAt: '2026-10-27T00:00:00Z', expiresAt: '2026-10-28T00:00:00Z',
  payload: '{"fictionalSignedArtifact":"test"}', qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=', officialApaarAuthenticity: 'not_verified' };
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status,
  headers: new Headers({ 'content-type': 'application/json' }), json: async () => body }; }
beforeEach(() => { clearSession(); setSessionHandler(() => {}); });

describe('issuance', () => {
  it('issues only a record reference, renders QR/download/payload and confirms revocation', async () => {
    const fetch = vi.fn(async url => url.endsWith('/issue') ? response(artifact, 201) : response({ status: 'revoked' }));
    vi.stubGlobal('fetch', fetch);
    const actor = userEvent.setup(); render(<IssueArtifact studentId={id} />);
    expect(fetch).not.toHaveBeenCalled();
    await actor.click(screen.getByText('Issue QR artifact'));
    expect(await screen.findByRole('img')).toHaveAttribute('src', artifact.qrDataUrl);
    expect(screen.getByRole('link', { name: 'Download QR PNG' })).toHaveAttribute('download', `eduverify-${id}.png`);
    expect(screen.getByLabelText('Signed QR payload (copy as text)')).toHaveValue(artifact.payload);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ studentId: id });
    await actor.click(screen.getByText('Revoke this artifact')); expect(fetch).toHaveBeenCalledTimes(1);
    await actor.click(screen.getByText('Confirm revocation'));
    expect(await screen.findByText('Artifact revoked. Do not share this QR.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ artifactId: id });
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it('missing keys prevent any issued/download state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'secret must never render' }, 503)));
    render(<IssueArtifact studentId={id} />); await userEvent.click(screen.getByText('Issue QR artifact'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Verification service or signing configuration unavailable');
    expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(screen.queryByText(/secret must/)).not.toBeInTheDocument();
  });
  it('rejects untrusted QR image URLs and suppresses duplicate issuance', async () => {
    let release; const fetch = vi.fn(() => new Promise(resolve => { release = resolve; })); vi.stubGlobal('fetch', fetch);
    render(<IssueArtifact studentId={id} />); await userEvent.dblClick(screen.getByText('Issue QR artifact')); expect(fetch).toHaveBeenCalledTimes(1);
    release(response({ ...artifact, qrDataUrl: 'https://attacker.example/tracker' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid response'); expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('public verification', () => {
  it.each(['valid', 'invalid', 'expired', 'revoked', 'outdated'])('renders %s with separate integrity and current status', async status => {
    const result = { status, integrityValid: status !== 'invalid', recordCurrent: status === 'valid' ? true : status === 'outdated' ? false : null,
      checkedAt: '2026-10-27T00:00:00Z', officialApaarAuthenticity: 'not_verified' };
    const fetch = vi.fn(async () => response(result)); vi.stubGlobal('fetch', fetch);
    render(<VerifyArtifact />); await userEvent.type(screen.getByLabelText('QR payload'), 'fictional-signed-payload');
    await userEvent.click(screen.getByRole('button', { name: 'Verify artifact' }));
    expect(await screen.findByText(`Artifact status: ${status}`)).toBeInTheDocument();
    expect(screen.getByText(/does not prove identity, official APAAR authenticity/)).toBeInTheDocument();
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/verification/verify');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ payload: 'fictional-signed-payload' });
  });
  it('service errors never render a valid result and clear a prior result on input change', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({}, 500)));
    render(<VerifyArtifact />); await userEvent.type(screen.getByLabelText('QR payload'), 'fictional'); await userEvent.click(screen.getByText('Verify artifact'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Verification could not be completed');
    expect(screen.queryByText('Artifact status: valid')).not.toBeInTheDocument();
  });
  it('does not accept an inconsistent valid/current response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ status: 'valid', integrityValid: true, recordCurrent: false, checkedAt: 'now', officialApaarAuthenticity: 'not_verified' })));
    render(<VerifyArtifact />); await userEvent.type(screen.getByLabelText('QR payload'), 'fictional'); await userEvent.click(screen.getByText('Verify artifact'));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid response'); expect(screen.queryByText('Artifact status: valid')).not.toBeInTheDocument();
  });
  it('rejects expired outcomes that do not establish signature integrity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ status: 'expired', integrityValid: false, recordCurrent: null, checkedAt: 'now', officialApaarAuthenticity: 'not_verified' })));
    render(<VerifyArtifact />); await userEvent.type(screen.getByLabelText('QR payload'), 'fictional'); await userEvent.click(screen.getByText('Verify artifact'));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid response'); expect(screen.queryByText('Artifact status: expired')).not.toBeInTheDocument();
  });
  it('is reachable without login and makes no student requests', async () => {
    const fetch = vi.fn(async url => url.endsWith('/csrf') ? response({ csrfToken: 'a'.repeat(64) }) : response({}, 401)); vi.stubGlobal('fetch', fetch);
    render(<App />); await userEvent.click(await screen.findByText('Public artifact verification'));
    expect(screen.getByRole('heading', { name: 'Verify an EduVerify artifact' })).toBeInTheDocument();
    expect(fetch.mock.calls.every(([url]) => url.startsWith('/api/auth/'))).toBe(true);
    expect(screen.queryByText('Issue QR artifact')).not.toBeInTheDocument();
  });
  it('reviewers get verification navigation without issuance or restricted data calls', async () => {
    const fetch = vi.fn(async url => url.endsWith('/csrf') ? response({ csrfToken: 'a'.repeat(64) }) : response({ user: { id: 'reviewer', displayName: 'Fictional Reviewer', role: 'regulatory_reviewer' } })); vi.stubGlobal('fetch', fetch);
    render(<App />); await userEvent.click(await screen.findByRole('button', { name: 'Verification' }));
    expect(screen.getByLabelText('QR payload')).toBeInTheDocument(); expect(screen.queryByText('Issue QR artifact')).not.toBeInTheDocument();
    await waitFor(() => expect(fetch.mock.calls.every(([url]) => url.startsWith('/api/auth/'))).toBe(true));
  });
});
