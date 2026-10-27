import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { StudentForm, Students } from '../students';
import Import from '../Import';
import { Compliance, Ml } from '../Reviews';
import * as api from '../api';

const token = 'a'.repeat(64);
const user = { id: 'demo-user', displayName: 'Fictional Admin', role: 'institution_admin', institutionId: 'DEMO-INST-001' };
const student = { id: 'demo-student', studentName: 'Fictional Learner', apaarId: '000000000099', programmeId: 'DEMO-PROG-001', academicYear: '2026-2027', admissionYear: '2026', admissionCategory: 'general', status: 'active' };
const summary = { findingsBySeverity: { info: 0, warning: 1, critical: 0 }, violations: 0, manualReviewItems: 1, intakeComparisons: [] };
const metadata = { summary, evaluation: { evaluatedAt: '2026-10-26', checkedAt: '2026-10-26' }, stale: true };
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body }; }
function mockApi(routes = {}) {
  const fetch = vi.fn(async (url, options) => {
    if (url === '/api/auth/csrf') return response({ csrfToken: token });
    const handler = routes[url];
    if (handler) return typeof handler === 'function' ? handler(options) : response(handler);
    if (url === '/api/v1/students?page=1&pageSize=1') return response({ total: 0 });
    if (url === '/api/v1/compliance/summary') return response(metadata);
    throw new Error(`Unexpected request: ${url}`);
  }); vi.stubGlobal('fetch', fetch); return fetch;
}
beforeEach(() => { api.clearSession(); api.setSessionHandler(() => {}); });

describe('session and role workflows', () => {
  it('logs in with CSRF, normalized email and cookie credentials; logs out', async () => {
    const fetch = mockApi({ '/api/auth/me': () => response({}, 401), '/api/auth/login': { user, csrfToken: 'b'.repeat(64) }, '/api/auth/logout': () => response(null, 204) });
    const actor = userEvent.setup(); render(<App />);
    await actor.type(await screen.findByLabelText('Email'), 'ADMIN@demo.example'); await actor.type(screen.getByLabelText('Password'), 'fictional-only-password');
    await actor.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Fictional Admin')).toBeInTheDocument();
    const login = fetch.mock.calls.find(([url]) => url.endsWith('/login'))[1];
    expect(login.credentials).toBe('include'); expect(login.headers['X-CSRF-Token']).toBe(token); expect(JSON.parse(login.body).email).toBe('admin@demo.example');
    await actor.click(screen.getByRole('button', { name: 'Logout' })); expect(await screen.findByText('Signed out.')).toBeInTheDocument();
    expect(fetch.mock.calls.find(([url]) => url.endsWith('/logout'))[1].headers['X-CSRF-Token']).toBe('b'.repeat(64));
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it('shows safe login failure and clears password', async () => {
    mockApi({ '/api/auth/me': () => response({}, 401), '/api/auth/login': () => response({ error: '<script>secret</script>' }, 401) });
    const actor = userEvent.setup(); render(<App />); await actor.type(await screen.findByLabelText('Email'), 'x@demo.example'); await actor.type(screen.getByLabelText('Password'), 'bad'); await actor.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password'); expect(screen.getByLabelText('Password')).toHaveValue(''); expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });
  it.each(['regulatory_reviewer', 'authorized_verifier', 'unknown_role'])('makes no restricted calls for %s', async role => {
    const fetch = mockApi({ '/api/auth/me': { user: { ...user, role, institutionId: null } } }); render(<App />);
    expect(await screen.findByText(/No student, compliance, aggregate or ML access/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Students' })).not.toBeInTheDocument(); expect(fetch.mock.calls.every(([url]) => url.startsWith('/api/auth/'))).toBe(true);
  });
  it.each(['institution_admin', 'institution_operator'])('shows permitted navigation for %s', async role => {
    mockApi({ '/api/auth/me': { user: { ...user, role } } }); render(<App />);
    expect(await screen.findByRole('navigation')).toHaveTextContent('CSV import'); expect(screen.getByRole('navigation')).toHaveTextContent('ML review');
  });
  it('clears protected UI on expired session', async () => {
    mockApi({ '/api/auth/me': { user }, '/api/v1/students?page=1&pageSize=1': () => response({}, 401) }); render(<App />);
    expect(await screen.findByText('Session expired. Please sign in again.')).toBeInTheDocument(); expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

describe('student management', () => {
  it('validates create before sending any request', async () => {
    const fetch = mockApi(); render(<StudentForm onSaved={vi.fn()} onCancel={vi.fn()} />); await userEvent.click(screen.getByRole('button', { name: 'Save student' }));
    expect(screen.getByRole('alert')).toHaveTextContent('APAAR must contain exactly 12 digits'); expect(fetch).not.toHaveBeenCalled();
  });
  it('creates a valid fictional student and disables repeated submits', async () => {
    let complete; const fetch = mockApi({ '/api/v1/students': () => new Promise(resolve => { complete = () => resolve(response({ student }, 201)); }) });
    const saved = vi.fn(); const actor = userEvent.setup(); render(<StudentForm onSaved={saved} onCancel={vi.fn()} />);
    for (const [label, value] of [['Student name', student.studentName], ['APAAR (12-digit fictional text)', student.apaarId], ['Programme ID', student.programmeId], ['Academic year (YYYY-YYYY)', student.academicYear], ['Admission year', student.admissionYear]]) await actor.type(screen.getByLabelText(label), value);
    await actor.dblClick(screen.getByRole('button', { name: 'Save student' })); expect(fetch).toHaveBeenCalledTimes(1); expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled(); complete(); await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty('institutionId');
  });
  it('validates edits and PATCHes only writable fields', async () => {
    const fetch = mockApi({ '/api/v1/students/demo-student': { student } }); const saved = vi.fn(); const actor = userEvent.setup(); render(<StudentForm student={student} onSaved={saved} onCancel={vi.fn()} />);
    await actor.clear(screen.getByLabelText('Admission year')); await actor.type(screen.getByLabelText('Admission year'), '2028'); await actor.click(screen.getByText('Save student')); expect(fetch).not.toHaveBeenCalled();
    await actor.clear(screen.getByLabelText('Admission year')); await actor.type(screen.getByLabelText('Admission year'), '2025'); await actor.click(screen.getByText('Save student')); await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(fetch.mock.calls[0][1].method).toBe('PATCH'); expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty('id');
  });
  it('lists, filters, paginates and opens permitted details without showing APAAR in the list', async () => {
    const fetch = mockApi({ '/api/v1/students?page=1&pageSize=20': { records: [student], total: 21 }, '/api/v1/students?page=2&pageSize=20': { records: [student], total: 21 }, '/api/v1/students/demo-student': { student }, '/api/v1/students?programmeId=DEMO-PROG-001&page=1&pageSize=20': { records: [student], total: 1 } });
    const actor = userEvent.setup(); render(<Students onMutation={vi.fn()} />); await screen.findByText(student.studentName); expect(screen.queryByText(student.apaarId)).not.toBeInTheDocument(); await actor.click(screen.getByText('Next')); await screen.findByText('Page 2 · 21 results');
    await actor.type(screen.getByLabelText('Programme filter'), 'DEMO-PROG-001'); await actor.click(screen.getByText('Apply filters')); await screen.findByText('Page 1 · 1 results'); await actor.click(screen.getByText(`View ${student.studentName}`)); expect(await screen.findByText(student.apaarId)).toBeInTheDocument(); expect(fetch.mock.calls.some(([url]) => url.includes('programmeId='))).toBe(true);
  });
});

describe('CSV import', () => {
  const preview = { summary: { total: 1, valid: 1, invalid: 0, duplicate: 0, conflict: 0 }, rows: [{ rowNumber: 2, classification: 'valid', errors: [] }], previewToken: 'private-preview', expiresAt: '2026-10-26' };
  async function upload() { const actor = userEvent.setup(); await actor.upload(screen.getByLabelText('CSV file'), new File(['fictional,csv'], 'demo.csv', { type: 'text/csv' })); await actor.click(screen.getByText('Preview CSV')); return actor; }
  it('previews, requires explicit confirmation and shows only server-confirmed import', async () => {
    const fetch = mockApi({ '/api/v1/students/import/preview': preview, '/api/v1/students/import/commit': { imported: 1 } }); const changed = vi.fn(); render(<Import onMutation={changed} />); const actor = await upload(); await screen.findByText('Preview only — no records imported'); expect(fetch).toHaveBeenCalledTimes(1);
    await actor.click(screen.getByText('Review and commit')); expect(fetch).toHaveBeenCalledTimes(1); await actor.click(screen.getByRole('button', { name: 'Confirm import' })); expect(await screen.findByText(/Import confirmed by server: 1/)).toBeInTheDocument(); expect(changed).toHaveBeenCalledTimes(1); expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ previewToken: 'private-preview' });
  });
  it('renders invalid, duplicate and conflict rows without a commit action', async () => {
    mockApi({ '/api/v1/students/import/preview': { summary: { total: 3, valid: 0, invalid: 1, duplicate: 1, conflict: 1 }, rows: ['invalid', 'duplicate', 'conflict'].map((classification, i) => ({ rowNumber: i + 2, classification, errors: [{ field: 'apaarId', code: classification, message: 'Requires correction' }] })) } }); render(<Import onMutation={vi.fn()} />); await upload(); expect(await screen.findByText('conflict')).toBeInTheDocument(); expect(screen.queryByText('Review and commit')).not.toBeInTheDocument();
  });
  it('handles expired, duplicate or revalidated commit failures without success', async () => {
    mockApi({ '/api/v1/students/import/preview': preview, '/api/v1/students/import/commit': () => response({}, 409) }); render(<Import onMutation={vi.fn()} />); const actor = await upload(); await actor.click(await screen.findByText('Review and commit')); await actor.click(screen.getByRole('button', { name: 'Confirm import' })); expect(await screen.findByRole('alert')).toHaveTextContent('expired'); expect(screen.queryByText('Review and commit')).not.toBeInTheDocument(); expect(screen.queryByText(/Import confirmed/)).not.toBeInTheDocument();
  });
  it('rejects oversized files before upload', async () => { const fetch = mockApi(); render(<Import onMutation={vi.fn()} />); await userEvent.upload(screen.getByLabelText('CSV file'), new File(['a'.repeat(262145)], 'demo.csv', { type: 'text/csv' })); await userEvent.click(screen.getByText('Preview CSV')); expect(await screen.findByRole('alert')).toHaveTextContent('256 KiB'); expect(fetch).not.toHaveBeenCalled(); });
});

describe('compliance and ML', () => {
  it('renders stale severity, rule, review reason and explicit evaluation', async () => {
    const findings = [{ id: 'f', severity: 'warning', ruleCode: 'INTAKE_POLICY_REVIEW', kind: 'requires_review', institutionId: 'DEMO-INST-001', programmeId: 'DEMO-PROG-001', academicYear: '2026-2027', explanation: 'Counting policy missing', recommendedAction: 'Configure explicit policy' }];
    const fetch = mockApi({ '/api/v1/compliance/findings?page=1&pageSize=20': { ...metadata, findings, total: 1 }, '/api/v1/compliance/evaluate': metadata }); render(<Compliance />); expect(await screen.findByText(/Stale — reevaluation required/)).toBeInTheDocument(); expect(screen.getByText('INTAKE_POLICY_REVIEW')).toBeInTheDocument(); expect(screen.getByText('Requires human review')).toBeInTheDocument(); await userEvent.click(screen.getByText('Evaluate institution')); await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/evaluate'))).toBe(true));
  });
  it('keeps evaluation errors visible', async () => { mockApi({ '/api/v1/compliance/findings?page=1&pageSize=20': { ...metadata, findings: [], total: 0 }, '/api/v1/compliance/evaluate': () => response({}, 500) }); render(<Compliance />); await screen.findByText(/Stale —/); await userEvent.click(screen.getByText('Evaluate institution')); expect(await screen.findByRole('alert')).toHaveTextContent('Request failed'); });
  it('shows unavailable ML as failure, never a normal result', async () => { mockApi({ '/api/v1/ml/evaluate': () => response({}, 503) }); const onResult = vi.fn(); render(<Ml result={null} onResult={onResult} />); await userEvent.click(screen.getByText('Run ML analysis')); expect(await screen.findByRole('alert')).toHaveTextContent('ML service unavailable'); expect(screen.queryByText('Below model threshold')).not.toBeInTheDocument(); expect(onResult).toHaveBeenCalledWith(null); });
  it('submits ML filters only to Express and accepts a validated successful response', async () => {
    const result = { status: 'evaluated', stale: false, modelVersion: 'synthetic', threshold: 0.63, skippedRecords: 0, results: [{ programmeId: 'DEMO-PROG-001', academicYear: '2026-2027', anomalyScore: 0.8, reviewFlag: true, missingFeatures: [] }] };
    const fetch = mockApi({ '/api/v1/ml/evaluate': result }); const onResult = vi.fn(); render(<Ml result={null} onResult={onResult} />);
    await userEvent.type(screen.getByLabelText('Programme ID (optional)'), 'DEMO-PROG-001'); await userEvent.click(screen.getByText('Run ML analysis'));
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(result)); expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ programmeId: 'DEMO-PROG-001' });
  });
  it('retains a failed analysis state without presenting successful or normal results', () => { render(<Ml result={{ status: 'failed', results: [] }} onResult={vi.fn()} />); expect(screen.getByRole('alert')).toHaveTextContent('Previous ML analysis could not be completed'); expect(screen.queryByText(/ML analysis completed/)).not.toBeInTheDocument(); });
  it('renders score, missing features and review flag separately', () => { render(<Ml onResult={vi.fn()} result={{ status: 'evaluated', modelVersion: 'synthetic', threshold: 0.63, skippedRecords: 0, stale: false, results: [{ programmeId: 'DEMO-PROG-001', academicYear: '2026-2027', anomalyScore: 0.8, reviewFlag: true, missingFeatures: ['intake_ratio'] }] }} />); expect(screen.getByText('0.8000')).toBeInTheDocument(); expect(screen.getByText('Human review required')).toBeInTheDocument(); expect(screen.getByText('intake_ratio')).toBeInTheDocument(); });
});
