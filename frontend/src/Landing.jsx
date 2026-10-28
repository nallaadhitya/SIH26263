const capabilities = [
  ['Institution records', 'Maintain scoped fictional student records with structured admission and programme context.'],
  ['Bulk validation', 'Preview CSV submissions, surface row-level issues, and commit only server-confirmed batches.'],
  ['Enrolment compliance', 'Review deterministic intake comparisons, findings, and evaluation freshness.'],
  ['Discrepancy review', 'Separate rule-based exceptions from items requiring institutional review.'],
  ['ML-assisted review', 'Use bounded aggregate signals as review prompts, never as identity or fraud decisions.'],
  ['Signed artifacts', 'Issue and check signed QR artifacts with explicit integrity and currentness states.'],
];

function Mark() { return <span className="landing-mark" aria-hidden="true"><i /><i /><i /></span>; }

export default function Landing({ onLogin, onVerify }) {
  return <div className="landing">
    <a className="skip" href="#landing-content">Skip to content</a>
    <header className="landing-header">
      <a className="landing-brand" href="#overview" aria-label="EduVerify Intelligence overview"><Mark /><span>EduVerify <b>Intelligence</b></span></a>
      <nav aria-label="Public navigation"><a href="#overview">Overview</a><a href="#capabilities">Capabilities</a><a href="#workflow">How it works</a><a href="#faq">FAQ</a></nav>
      <button className="landing-login" onClick={onLogin}>Sign in</button>
    </header>
    <main id="landing-content">
      <section className="landing-hero" id="overview">
        <div className="hero-copy"><p className="landing-kicker">Institutional data assurance</p><h1>Clearer academic data. More confident review.</h1><p>EduVerify Intelligence is a local demonstration platform for managing fictional academic records, structured validation, compliance review, and signed verification artifacts.</p><div className="hero-actions"><button className="landing-primary" onClick={onLogin}>Sign in to workspace</button><button className="landing-secondary" onClick={onVerify}>Verify an artifact</button></div><p className="hero-note">Local prototype · fictional data only · no official APAAR integration</p></div>
        <div className="hero-panel" aria-label="Platform capabilities summary"><div className="panel-top"><span>REVIEW CONTEXT</span><b>Institutional workspace</b></div><div className="panel-list"><div><Mark /><span><b>Structured intake review</b><small>Policy-aware comparisons</small></span></div><div><Mark /><span><b>Explicit data quality signals</b><small>Human review remains essential</small></span></div><div><Mark /><span><b>Signed artifact status</b><small>Integrity and currentness distinguished</small></span></div></div><div className="panel-footer"><span className="live-dot" />Local demonstration environment</div></div>
      </section>
      <section className="landing-band"><p>Designed for transparent institutional workflows</p><div><span>Scoped access</span><span>Explicit evaluation</span><span>Safe verification</span><span>Privacy boundary</span></div></section>
      <section className="landing-section" id="capabilities"><div className="section-intro"><p className="landing-kicker">Capabilities</p><h2>One coherent workspace for data assurance</h2><p>Each workflow is connected to the platform’s authorized backend behavior—nothing presented as a live result is fabricated.</p></div><div className="capability-grid">{capabilities.map(([title, description], index) => <article key={title}><span className="capability-number">0{index + 1}</span><h3>{title}</h3><p>{description}</p></article>)}</div></section>
      <section className="landing-section workflow-section" id="workflow"><div className="section-intro"><p className="landing-kicker">How it works</p><h2>From submitted data to an informed review</h2></div><ol className="workflow"><li><span>01</span><div><h3>Prepare and validate</h3><p>Institution users create records or preview a bounded CSV submission before any commit occurs.</p></div></li><li><span>02</span><div><h3>Evaluate with context</h3><p>Deterministic checks identify configured rule findings and clearly mark stale evaluations.</p></div></li><li><span>03</span><div><h3>Verify with limits</h3><p>Authorized artifacts can be checked for signature integrity, expiry, revocation, and record currentness.</p></div></li></ol></section>
      <section className="landing-section assurance"><div><p className="landing-kicker">Privacy and security</p><h2>Designed to make boundaries visible</h2><p>Role-aware access, institution scoping, server-side authorization, CSRF protection, and minimal artifact disclosure are part of the existing local prototype. ML receives only permitted aggregates, not student identities or raw files.</p></div><ul><li>Permissions are enforced by the backend, not merely hidden in the interface.</li><li>Artifact integrity, source-record currentness, compliance, and APAAR authenticity are distinct outcomes.</li><li>Local-only demonstration data is deliberately fictional.</li></ul></section>
      <section className="landing-section limitations" id="faq"><p className="landing-kicker">Prototype limitations</p><h2>What this demonstration does not claim</h2><div><p>EduVerify Intelligence is not an official government website, AICTE service, regulatory certificate issuer, or official APAAR authentication system. It has no connection to government registries and does not validate identity.</p><p>Camera QR scanning, production deployment, official integrations, and regulatory-wide monitoring require separate authorization and implementation.</p></div></section>
      <section className="landing-cta"><div><p className="landing-kicker">Local demonstration</p><h2>Explore the authorized workspace</h2><p>Use locally seeded fictional credentials to review the available institution workflows.</p></div><button className="landing-primary" onClick={onLogin}>Sign in to workspace</button></section>
    </main>
    <footer className="landing-footer"><div className="landing-brand"><Mark /><span>EduVerify <b>Intelligence</b></span></div><p>Local prototype for fictional demonstration data. Artifact checks do not prove identity, regulatory approval, or official APAAR authenticity.</p></footer>
  </div>;
}
