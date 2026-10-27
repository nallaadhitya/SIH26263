import { useEffect, useRef, useState } from 'react';
export function Message({ error, children }) { return <p role={error ? 'alert' : 'status'} className={error ? 'notice error' : 'notice'}>{children}</p>; }
export function Field({ label, ...props }) { return <label>{label}<input maxLength={256} {...props} /></label>; }
export function Select({ label, options, ...props }) { return <label>{label}<select {...props}>{options.map(value => <option key={value} value={value}>{value || 'All'}</option>)}</select></label>; }
export function Table({ headings, children }) { return <div className="table-scroll" role="region" aria-label={`${headings[0]} data table`} tabIndex={0}><table><thead><tr>{headings.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
export function Pagination({ page, total, size = 20, onChange, disabled }) { return <div className="actions"><button disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}>Previous</button><span>Page {page} · {total} results</span><button disabled={disabled || page * size >= total} onClick={() => onChange(page + 1)}>Next</button></div>; }
export function Confirm({ onCancel, onConfirm, busy }) {
  const ref = useRef();
  useEffect(() => { const opener = document.activeElement; ref.current.showModal(); return () => opener?.focus(); }, []);
  return <dialog ref={ref} aria-labelledby="confirm-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}><h2 id="confirm-title">Confirm import</h2><p>Commit all validated rows to your institution? This cannot be undone in this interface.</p><div className="actions"><button autoFocus disabled={busy} onClick={onCancel}>Cancel</button><button disabled={busy} onClick={onConfirm}>{busy ? 'Importing…' : 'Confirm import'}</button></div></dialog>;
}
export function useAction() {
  const lock = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function run(action) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { return await action(); } catch (e) { setError(e.message); } finally { lock.current = false; setBusy(false); } }
  return { busy, error, run };
}
