import { useEffect, useState } from 'react';
import * as api from './api';
import { Field, Message, useAction } from './ui';
import { Students } from './students';
import Import from './Import';
import { Compliance, Dashboard, Ml } from './Reviews';
import { VerifyArtifact } from './Verification';
export const institutionRole = role => ['institution_admin', 'institution_operator'].includes(role);
export default function App() {
  const [user, setUser] = useState(null); const [booting, setBooting] = useState(true); const [notice, setNotice] = useState(''); const [page, setPage] = useState('Overview'); const [mlResult, setMlResult] = useState(null);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const action = useAction();
  const [publicVerification, setPublicVerification] = useState(false);
  function reset() { setUser(null); setMlResult(null); setPage('Overview'); setPassword(''); }
  useEffect(() => {
    let alive = true;
    api.setSessionHandler(() => { if (alive) { reset(); setNotice('Session expired. Please sign in again.'); } });
    (async () => { try { await api.bootstrap(); const result = await api.me(); if (alive) { setUser(result.user); setNotice(''); } } catch (e) { if (alive) setNotice(e.status === 401 ? '' : e.message); } finally { if (alive) setBooting(false); } })();
    return () => { alive = false; api.setSessionHandler(() => {}); };
  }, []);
  async function signIn(e) { e.preventDefault(); await action.run(async () => { try { const result = await api.login(email, password); setUser(result.user); setNotice(''); setPage('Overview'); } finally { setPassword(''); } }); }
  async function signOut() { await action.run(async () => { await api.logout(); reset(); setNotice('Signed out.'); }); }
  if (booting) return <main><Message>Checking session…</Message></main>;
  if (publicVerification) return <main><h1>EduVerify Intelligence</h1><VerifyArtifact /><button onClick={() => setPublicVerification(false)}>Back to workspace</button></main>;
  if (!user) return <main className="login"><div className="brand">EV / EduVerify Intelligence</div><h1>Sign in to your workspace</h1><p>Local prototype · fictional demonstration data only</p>{notice && <Message>{notice}</Message>}<form onSubmit={signIn}><fieldset disabled={action.busy}><Field label="Email" type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /><Field label="Password" type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /><button>{action.busy ? 'Signing in…' : 'Sign in'}</button></fieldset></form>{action.error && <Message error>{action.error}</Message>}<p>Use an account seeded by your local administrator. No default password is bundled.</p><button onClick={() => { setPassword(''); setPublicVerification(true); }}>Public artifact verification</button></main>;
  const permitted = institutionRole(user.role);
  return <div className="app"><a className="skip" href="#content">Skip to content</a><aside><div className="brand">EV / EduVerify<br />Intelligence</div><p className="muted">LOCAL DEMO WORKSPACE</p><nav aria-label="Main navigation">{(permitted ? ['Overview', 'Students', 'CSV import', 'Compliance', 'ML review', 'Verification'] : ['Overview', 'Verification']).map(name => <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => { setPage(name); setNotice(''); }}>{name}</button>)}</nav></aside><div className="workspace"><header><div><strong>{user.displayName}</strong><div>{user.role} {user.institutionId && `· ${user.institutionId}`}</div></div><button disabled={action.busy} onClick={signOut}>Logout</button></header><main id="content" tabIndex={-1}><h1>{page}</h1>{action.error && <Message error>{action.error}</Message>}{page === 'Verification' ? <VerifyArtifact /> : !permitted ? <section><h2>Welcome</h2><p>Your {user.role} account is signed in. No student, compliance, aggregate or ML access is permitted for this role. Use Verification for the public artifact-status check. Dedicated regulatory data review remains deferred.</p></section> : <>
    {page === 'Overview' && <Dashboard navigate={setPage} mlResult={mlResult} />}
    {page === 'Students' && <Students onMutation={() => setMlResult(null)} />}
    {page === 'CSV import' && <Import onMutation={() => setMlResult(null)} />}
    {page === 'Compliance' && <Compliance />}
    {page === 'ML review' && <Ml result={mlResult} onResult={setMlResult} />}
  </>}<footer>Fictional data only. APAAR format checks are not official identity verification. Backend permissions remain authoritative.</footer></main></div></div>;
}
