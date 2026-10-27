import { useEffect, useState } from 'react';
import { request, query } from './api';
import { studentShape, studentsShape } from './contracts';
import { Field, Select, Table, Pagination, Message, useAction } from './ui';
import { IssueArtifact } from './Verification';
export const statuses = ['active', 'inactive', 'graduated', 'withdrawn'];
export const categories = ['general', 'obc', 'sc', 'st', 'ews', 'other', 'not_specified'];
const empty = { studentName: '', apaarId: '', programmeId: '', academicYear: '', admissionYear: '', admissionCategory: 'not_specified', status: 'active' };
export function validateStudent(values) {
  const errors = [];
  for (const key of Object.keys(empty)) if (!values[key]?.trim() || values[key].length > 256 || /[\u0000-\u001f\u007f]/.test(values[key])) errors.push(`${key}: required text, at most 256 characters, without control characters.`);
  if (!/^[0-9]{12}$/.test(values.apaarId)) errors.push('APAAR must contain exactly 12 digits.');
  const years = /^(20[0-9]{2})-(20[0-9]{2})$/.exec(values.academicYear);
  if (!years || Number(years[2]) !== Number(years[1]) + 1) errors.push('Academic year must be consecutive YYYY-YYYY years within 2000–2099.');
  if (!/^20[0-9]{2}$/.test(values.admissionYear) || (years && Number(values.admissionYear) > Number(years[1]))) errors.push('Admission year must not exceed the academic start year.');
  if (!statuses.includes(values.status) || !categories.includes(values.admissionCategory)) errors.push('Choose a supported status and category.');
  return errors;
}
export function StudentForm({ student, onSaved, onCancel }) {
  const [values, setValues] = useState(() => Object.fromEntries(Object.keys(empty).map(k => [k, student?.[k] ?? empty[k]])));
  const [errors, setErrors] = useState([]); const action = useAction();
  const bind = key => ({ value: values[key], onChange: e => setValues({ ...values, [key]: e.target.value }) });
  async function submit(event) {
    event.preventDefault(); const clean = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]));
    const found = validateStudent(clean); setErrors(found); if (found.length) return;
    await action.run(async () => { await request(`/v1/students${student ? `/${encodeURIComponent(student.id)}` : ''}`, { method: student ? 'PATCH' : 'POST', body: clean, validate: d => studentShape(d.student) }); onSaved(); });
  }
  return <section><h2>{student ? 'Edit student' : 'Create student'}</h2><p>Fictional data only. APAAR syntax checks do not verify official identity. Institution ownership is set by your account.</p>
    <form onSubmit={submit} noValidate><fieldset disabled={action.busy}><div className="form-grid">
      <Field label="Student name" required {...bind('studentName')} /><Field label="APAAR (12-digit fictional text)" required inputMode="numeric" {...bind('apaarId')} />
      <Field label="Programme ID" required {...bind('programmeId')} /><Field label="Academic year (YYYY-YYYY)" required {...bind('academicYear')} /><Field label="Admission year" required {...bind('admissionYear')} />
      <Select label="Admission category" options={categories} {...bind('admissionCategory')} /><Select label="Status" options={statuses} {...bind('status')} />
    </div><p>Enter an existing programme ID belonging to your institution. Reference lists are not available through the current API; ask the local demo administrator.</p>
      {errors.length > 0 && <div role="alert"><ul>{errors.map(e => <li key={e}>{e}</li>)}</ul></div>}
      {action.error && <Message error>{action.error}</Message>}<div className="actions"><button type="submit">{action.busy ? 'Saving…' : 'Save student'}</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </fieldset></form></section>;
}
export function Students({ onMutation }) {
  const [data, setData] = useState(null); const [page, setPage] = useState(1); const [filters, setFilters] = useState({ programmeId: '', academicYear: '', status: '' });
  const [applied, setApplied] = useState(filters); const [view, setView] = useState('list'); const [selected, setSelected] = useState(null); const [success, setSuccess] = useState(''); const [revision, setRevision] = useState(0);
  const action = useAction();
  useEffect(() => { let alive = true; setData(null); action.run(async () => { const result = await request(`/v1/students?${query({ ...applied, page, pageSize: 20 })}`, { validate: studentsShape }); if (alive) setData(result); }); return () => { alive = false; }; }, [page, applied, revision]);
  async function open(id) { await action.run(async () => { const result = await request(`/v1/students/${encodeURIComponent(id)}`, { validate: d => studentShape(d.student) }); setSelected(result.student); setView('detail'); }); }
  if (view === 'create' || view === 'edit') return <StudentForm student={view === 'edit' ? selected : null} onCancel={() => setView('list')} onSaved={() => { setSuccess('Student saved. Reevaluate compliance and ML after changes.'); onMutation(); setView('list'); setRevision(r => r + 1); }} />;
  if (view === 'detail') return <section><h2>Student record</h2><dl>{Object.keys(empty).map(k => <div key={k}><dt>{k}</dt><dd>{selected[k]}</dd></div>)}</dl><p>Official APAAR authenticity has not been verified.</p><div className="actions"><button onClick={() => setView('edit')}>Edit student</button><button onClick={() => setView('list')}>Back to list</button></div><IssueArtifact key={selected.id} studentId={selected.id} /></section>;
  return <section><div className="section-heading"><h2>Students</h2><button disabled={action.busy} onClick={() => setView('create')}>Create student</button></div>
    {success && <Message>{success}</Message>}<form onSubmit={e => { e.preventDefault(); setPage(1); setApplied({ ...filters }); }}><fieldset disabled={action.busy} className="filters"><Field label="Programme filter" value={filters.programmeId} onChange={e => setFilters({ ...filters, programmeId: e.target.value })} /><Field label="Academic year filter" value={filters.academicYear} onChange={e => setFilters({ ...filters, academicYear: e.target.value })} /><Select label="Status filter" options={['', ...statuses]} value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })} /><button>Apply filters</button></fieldset></form>
    {action.busy && <Message>Loading records…</Message>}{action.error && <Message error>{action.error}</Message>}
    {data && <><Table headings={['Name', 'Programme', 'Academic year', 'Status', 'Action']}>{data.records.map(s => <tr key={s.id}><td>{s.studentName}</td><td>{s.programmeId}</td><td>{s.academicYear}</td><td>{s.status}</td><td><button disabled={action.busy} onClick={() => open(s.id)}>View {s.studentName}</button></td></tr>)}</Table>{!data.records.length && <Message>No matching records. Create a fictional student or import a CSV.</Message>}<Pagination page={page} total={data.total} disabled={action.busy} onChange={setPage} /></>}
  </section>;
}
