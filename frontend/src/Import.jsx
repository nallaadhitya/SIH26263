import { useState } from 'react';
import { request } from './api';
import { previewShape } from './contracts';
import { Message, Table, Confirm, useAction } from './ui';
export default function Import({ onMutation }) {
  const [file, setFile] = useState(null); const [preview, setPreview] = useState(null); const [confirm, setConfirm] = useState(false); const [result, setResult] = useState(null); const action = useAction();
  async function upload(e) { e.preventDefault(); setPreview(null); setResult(null); await action.run(async () => {
    if (!file || !file.name.toLowerCase().endsWith('.csv') || !file.size || file.size > 256 * 1024) throw new Error('Select a nonempty CSV file of at most 256 KiB.');
    const form = new FormData(); form.append('file', file);
    setPreview(await request('/v1/students/import/preview', { method: 'POST', body: form, validate: previewShape }));
  }); }
  async function commit() { await action.run(async () => {
    // Consume the client preview even on an uncertain response. Never auto-retry a write.
    const token = preview.previewToken; setPreview(null);
    setResult(await request('/v1/students/import/commit', { method: 'POST', body: { previewToken: token }, validate: d => Number.isInteger(d.imported) })); onMutation();
  }); setConfirm(false); }
  return <section><h2>CSV import</h2><p>Fictional data only. One UTF-8 .csv file, 1–500 rows, at most 256 KiB; fields at most 256 characters. APAAR cells must remain text.</p><p>Required headers: <code>apaarId,studentName,institutionId,programmeId,academicYear,admissionYear</code>. Optional: <code>admissionCategory,status</code>. Use the repository template in data/demo/students-template.csv.</p>
    <form onSubmit={upload}><fieldset disabled={action.busy || confirm}><label>CSV file<input type="file" accept=".csv,text/csv" onChange={e => { setFile(e.target.files[0]); setPreview(null); setResult(null); }} /></label><button>Preview CSV</button></fieldset></form>
    {action.busy && <Message>Processing request…</Message>}{action.error && <Message error>{action.error} For an uncertain commit, inspect the student list before creating a new preview.</Message>}
    {preview && <><h3>Preview only — no records imported</h3><p>{Object.entries(preview.summary).map(([key, value]) => `${key}: ${value}`).join(' · ')}</p><Table headings={['Row', 'Classification', 'Issues']}>{preview.rows.map(row => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.classification}</td><td>{row.errors.map((e, i) => <p key={i}>{e.field}: {e.code} — {e.message}</p>)}</td></tr>)}</Table>{preview.previewToken ? <><p>Expires: {preview.expiresAt}. The server revalidates every row at commit.</p><button disabled={action.busy || confirm} onClick={() => setConfirm(true)}>Review and commit</button></> : <Message>Resolve all invalid, duplicate or conflicting rows, then preview again. No partial import is performed.</Message>}</>}
    {confirm && <Confirm busy={action.busy} onCancel={() => setConfirm(false)} onConfirm={commit} />}
    {result && <Message>Import confirmed by server: {result.imported} records imported. Reevaluate compliance and ML.</Message>}
  </section>;
}
