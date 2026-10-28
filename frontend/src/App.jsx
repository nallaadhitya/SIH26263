import { useEffect, useState } from 'react';
import * as api from './api';
import { Field, Message, useAction } from './ui';
import { Students } from './students';
import Import from './Import';
import { Compliance, Dashboard, Ml } from './Reviews';
import { VerifyArtifact } from './Verification';
import Landing from './Landing';
import { RegulatoryPortal, VerifierPortal } from './Portals';

export const institutionRole = role => ['institution_admin', 'institution_operator'].includes(role);
const supportedRoutes = new Set(['/', '/login', '/verify', '/workspace']);
const getRoute = () => supportedRoutes.has(window.location.pathname) ? window.location.pathname : '/';

function Login({ notice, email, password, setEmail, setPassword, action, onSubmit, onVerify }) {
  return <main className="login"><div className="login-identity"><div className="brand-mark">EV</div><div><div className="brand">EduVerify Intelligence</div><p>Institutional data assurance</p></div></div><div className="eyebrow">Secure local workspace</div><h1>Sign in to your workspace</h1><p className="login-intro">Manage fictional demonstration records, validation reviews, and signed artifact checks in one local environment.</p>{notice && <Message>{notice}</Message>}<form onSubmit={onSubmit}><fieldset disabled={action.busy}><Field label="Email" type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /><Field label="Password" type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /><button className="primary-action">{action.busy ? 'Signing in…' : 'Sign in'}</button></fieldset></form>{action.error && <Message error>{action.error}</Message>}<p className="login-help">Use an account seeded by your local administrator. No default password is bundled.</p><button className="text-action" onClick={onVerify}>Public artifact verification</button></main>;
}
function VerificationPage({ onBack }) { return <main className="public-page"><div className="public-brand">EV <span>EduVerify Intelligence</span></div><VerifyArtifact /><button onClick={onBack}>Back to overview</button></main>; }

export default function App() {
  const [user, setUser] = useState(null); const [booting, setBooting] = useState(true); const [notice, setNotice] = useState(''); const [page, setPage] = useState('Overview'); const [mlResult, setMlResult] = useState(null);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [route, setRoute] = useState(getRoute); const action = useAction();
  const go = destination => { window.history.pushState({}, '', destination); setRoute(destination); };
  function reset() { setUser(null); setMlResult(null); setPage('Overview'); setPassword(''); }
  useEffect(() => { const onPopState = () => setRoute(getRoute()); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState); }, []);
  useEffect(() => { document.title = route === '/' ? 'EduVerify Intelligence | Institutional data assurance' : route === '/verify' ? 'Verify artifact | EduVerify Intelligence' : route === '/login' ? 'Sign in | EduVerify Intelligence' : 'Workspace | EduVerify Intelligence'; }, [route]);
  useEffect(() => {
    let alive = true;
    api.setSessionHandler(() => { if (alive) { reset(); setNotice('Session expired. Please sign in again.'); if (window.location.pathname === '/workspace') go('/login'); } });
    (async () => { try { await api.bootstrap(); const result = await api.me(); if (alive) { setUser(result.user); setNotice(''); } } catch (e) { if (alive) setNotice(e.status === 401 ? '' : e.message); } finally { if (alive) setBooting(false); } })();
    return () => { alive = false; api.setSessionHandler(() => {}); };
  }, []);
  useEffect(() => { if (!booting && !user && route === '/workspace') go('/login'); }, [booting, user, route]);
  async function signIn(event) { event.preventDefault(); await action.run(async () => { try { const result = await api.login(email, password); setUser(result.user); setNotice(''); setPage('Overview'); go('/workspace'); } finally { setPassword(''); } }); }
  async function signOut() { await action.run(async () => { await api.logout(); reset(); setNotice('Signed out.'); go('/login'); }); }
  if (booting) return <main className="boot"><Message>Checking session…</Message></main>;
  if (route === '/') return <Landing onLogin={() => go('/login')} onVerify={() => go('/verify')} />;
  if (route === '/verify') return <VerificationPage onBack={() => go('/')} />;
  if (!user) return <Login notice={notice} email={email} password={password} setEmail={setEmail} setPassword={setPassword} action={action} onSubmit={signIn} onVerify={() => go('/verify')} />;
  if (user.role === 'regulatory_reviewer') return <PortalShell user={user} action={action} onSignOut={signOut}><RegulatoryPortal /></PortalShell>;
  if (user.role === 'authorized_verifier') return <PortalShell user={user} action={action} onSignOut={signOut}><VerifierPortal /></PortalShell>;
  const permitted = institutionRole(user.role); const navigation = permitted ? ['Overview', 'Students', 'CSV import', 'Compliance', 'ML review', 'Verification'] : ['Overview', 'Verification']; const roleLabel = user.role.replaceAll('_', ' ');
  return <div className="app"><a className="skip" href="#content">Skip to content</a><aside><div className="side-brand"><div className="brand-mark">EV</div><div className="brand">EduVerify <span>Intelligence</span></div></div><p className="muted">LOCAL DEMO WORKSPACE</p><nav aria-label="Main navigation">{navigation.map(name => <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => { setPage(name); setNotice(''); }}><span className="nav-dot" aria-hidden="true" />{name}</button>)}</nav><div className="side-notice"><strong>Privacy boundary</strong><span>Fictional data only</span></div></aside><div className="workspace"><header><div className="context"><span className="eyebrow">Workspace</span><strong>{page}</strong></div><div className="user-menu"><div><strong>{user.displayName}</strong><span>{roleLabel}{user.institutionId && ` · ${user.institutionId}`}</span></div><button disabled={action.busy} onClick={signOut}>Logout</button></div></header><main id="content" tabIndex={-1}><div className="page-heading"><div><p className="eyebrow">{permitted ? 'Institution workspace' : 'Restricted workspace'}</p><h1>{page}</h1></div>{permitted && user.institutionId && <span className="context-pill">{user.institutionId}</span>}</div>{action.error && <Message error>{action.error}</Message>}{page === 'Verification' ? <VerifyArtifact /> : !permitted ? <section className="restricted"><span className="status-dot" /><h2>Limited access is active</h2><p>Your {roleLabel} account is signed in. No student, compliance, aggregate or ML access is permitted for this role. Protected endpoints are not requested. Use Verification for the public artifact-status check. Dedicated regulatory monitoring remains deferred until authorized API support exists.</p></section> : <>{page === 'Overview' && <Dashboard navigate={setPage} mlResult={mlResult} />}{page === 'Students' && <Students onMutation={() => setMlResult(null)} />}{page === 'CSV import' && <Import onMutation={() => setMlResult(null)} />}{page === 'Compliance' && <Compliance />}{page === 'ML review' && <Ml result={mlResult} onResult={setMlResult} />}</>}<footer>Fictional data only. APAAR format checks are not official identity verification. Backend permissions remain authoritative.</footer></main></div></div>;
}

function PortalShell({ user, action, onSignOut, children }) {
  const name = user.role === 'regulatory_reviewer' ? 'AICTE Monitoring Portal' : 'Verification Portal';
  return <div className="app"><a className="skip" href="#content">Skip to content</a><aside><div className="side-brand"><div className="brand-mark">EV</div><div className="brand">EduVerify <span>Intelligence</span></div></div><p className="muted">{name}</p><nav aria-label="Main navigation"><button aria-current="page"><span className="nav-dot" aria-hidden="true" />{user.role === 'regulatory_reviewer' ? 'Monitoring overview' : 'Artifact review'}</button></nav><div className="side-notice"><strong>Access boundary</strong><span>{user.role === 'regulatory_reviewer' ? 'De-identified aggregates' : 'No student record browsing'}</span></div></aside><div className="workspace"><header><div className="context"><span className="eyebrow">Authorized workspace</span><strong>{name}</strong></div><div className="user-menu"><div><strong>{user.displayName}</strong><span>{user.role.replaceAll('_', ' ')}</span></div><button disabled={action.busy} onClick={onSignOut}>Logout</button></div></header><main id="content" tabIndex={-1}>{children}<footer>Fictional local prototype. Backend permissions remain authoritative.</footer></main></div></div>;
}
