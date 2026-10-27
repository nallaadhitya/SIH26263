# Repeatable SIH demonstration (target 6 minutes 30 seconds)

All people/institutions/accounts are fictional. Numeric APAAR samples below are synthetic syntax fixtures, not issued identifiers. EduVerify verifies its own artifact integrity/currentness, never official APAAR authenticity. Timing is a rehearsal target, not a measured performance claim.

## Prepare once

Use the locked setup in [README](../README.md) and [MySQL guide](mysql.md): Node 22.20.0/npm 10.9.3, Python 3.10.7 venv, backend/frontend dependencies, trusted offline-trained model, installed MySQL server/client/dump binaries and Chrome for automation. New installations should use a patched supported local MySQL release; acceptance reused installed 8.0.36 without changing the existing service.

From the project root in PowerShell, install if needed (do not overwrite an existing venv):

```powershell
Push-Location backend
npm ci --cache .npm-cache
Pop-Location
Push-Location frontend
npm ci --cache .npm-cache
Pop-Location
if (-not (Test-Path ml-service/.venv)) { python -m venv ml-service/.venv }
.\ml-service\.venv\Scripts\python.exe -m pip install --no-cache-dir -r ml-service/requirements-lock.txt
Push-Location ml-service
# Stop any ML process before generating/replacing trusted local artifacts.
.\.venv\Scripts\python.exe -m ml_app.train
Pop-Location
```

These are reproducible installation instructions; acceptance used the already installed locked environment, rather than claiming to reinstall it. No cloud service or paid API is needed. Do not distribute `.local/`, `.env`, model outputs, dumps, dependencies or personal records in the submission.

## Start an isolated live demonstration

Stop any development servers using 5000/5173/8000 first. The launcher refuses busy ports. It starts services in order, uses a fresh random disposable SQL database, applies migrations, seeds two institutions/two programmes/two intakes/five bcrypt accounts twice without duplication, and configures a **fictional one-seat** policy for `DEMO-PROG-001`, academic year `2026-2027`. It does not import or change `data/local/` or the normal application database. No pre-existing students are copied. It generates independent session/ML/QR secrets in memory and never prints them.

```powershell
# From project root:
Push-Location backend
npm run db:test-server
$env:ALLOW_MYSQL_TESTS = '1'
$demoCredential = Get-Credential -UserName 'admin@demo.example' -Message 'Choose a fictional demo password (12+ characters, at most 72 UTF-8 bytes)'
$env:DEMO_ACCOUNT_PASSWORD = $demoCredential.GetNetworkCredential().Password
Remove-Variable demoCredential
npm run demo:local
# The next commands run AFTER the demo stops:
Remove-Item Env:DEMO_ACCOUNT_PASSWORD
npm run db:test-server -- stop
Pop-Location
```

Wait for actual `python`, `backend`, `frontend` readiness messages; open **http://127.0.0.1:5173**. Use the chosen password for every demo account. Never project the password prompt, browser network cookies or signed payloads from real environments. The launcher accepts these commands in its terminal:

| Command | Effect |
| --- | --- |
| `ml-stop` | Stop only its Python child; UI inference must fail explicitly |
| `ml-start` | Restart Python with the same private key/model; rerun inference to show recovery |
| `restart` | Restart only Express, retaining SQL rows and QR keys; sessions/previews disappear, sign in again |
| `stop` | Stop owned services and delete only this generated demo database |

Every new launcher run is fresh. Re-importing the same CSV within one run intentionally produces duplicates; use `stop` and a fresh run for the next rehearsal. Use `stop` for reliable cleanup. If the launcher is forcibly killed, do not drop an unidentified schema; inspect the isolated test instance and identify that run's owned schema before manual cleanup. The test helper requires installed `mysqld` binaries and keeps its private files under ignored `.local/mysql/`.

For startup/recovery rehearsal without entering a password:

```powershell
Push-Location backend
$env:ALLOW_MYSQL_TESTS = '1'
npm run demo:local -- --check
Pop-Location
```

This checks real service startup, Python stop/restart and Express restart, then cleans up. It does not replace the complete browser workflow or the human demonstration.

## Presenter sequence

| Time | Action and explanation |
| --- | --- |
| 0:00–0:35 | Show ready services and sign in as `admin@demo.example`. Explain local MySQL, backend scope checks and fictional records. |
| 0:35–1:15 | Students → Create: name `Fictional Demo Learner`, APAAR `000000000081`, programme `DEMO-PROG-001`, academic year `2026-2027`, admission year `2026`; save, view, edit name to `Fictional Edited Learner`. Defaults are active/not_specified. |
| 1:15–2:00 | CSV import: preview [sih-invalid.csv](../data/demo/sih-invalid.csv); explain invalid identifier syntax and unavailable commit. Preview [sih-valid.csv](../data/demo/sih-valid.csv), review modal and explicitly confirm. Actual stored total is now two. No partial invalid-row import is implied. |
| 2:00–2:40 | Compliance → Evaluate institution. Show actual `INTAKE_EXCEEDED`: two active 2026 admissions counted under the explicit fictional policy versus one approved seat. Findings are deterministic; source changes stale this saved snapshot. This policy is not a government quota rule. |
| 2:40–3:25 | ML review → Run analysis. Explain the actual returned score/flag; do not promise a particular flag for this group. Type `ml-stop`, rerun to show unavailable state without a normal fallback; `ml-start`, rerun to show restored operation. |
| 3:25–4:25 | Open first student → Issue QR; copy payload → Verification, show `valid`. Edit the name, verify old payload as `outdated`. Issue a fresh artifact and explicitly revoke it; verify `revoked`. Explain signature integrity and source currentness separately. Public output has no name/APAAR/student ID. |
| 4:25–5:15 | Logout, show protected operations require login. Login `admin2@demo.example` and show its empty institution list. Login `operator@demo.example` to show own-institution access. Login reviewer/verifier to show their deliberately restricted landing pages and public verification. |
| 5:15–5:50 | Type `restart`, sign in as admin again, show both students persist. Recheck saved outdated/revoked payloads retained in the presenter's local clipboard/text area; SQL preserves state while sessions reset. Never claim previews survive restart. |
| 5:50–6:30 | State actual acceptance results and limitations. Show architecture and explain no official identity validation, synthetic-only ML and required production hardening. Type `stop` after the demonstration. |

Expired and invalid QR states are exercised by the automated Chrome scenario. It uses an injected verification clock to show expiry without waiting 24 hours; production expiry remains 24 hours. No demo-clock route or UI shortcut exists. Altering signed text produces `invalid`, not an authenticated record lookup.

## Roles demonstrated honestly

| Role/account | Implemented UI/API access |
| --- | --- |
| institution_admin — admin@demo.example | Own students/create/edit/import, own compliance/ML, issue/revoke; institution 001 |
| institution_operator — operator@demo.example | Same implemented student/compliance/ML/QR workflow for institution 001; no account-management UI/API |
| institution_admin — admin2@demo.example | Same capabilities for institution 002 only; another institution's detail/issue returns 404; scope overrides denied |
| regulatory_reviewer — reviewer@demo.example | Restricted landing page and minimal public artifact verification. No implemented cross-institution summary endpoint/dashboard is authorized |
| authorized_verifier — verifier@demo.example | Restricted landing page and minimal public artifact verification. No unrestricted student lookup/browse or issuing capability |

Declared policy permission labels for future reference management/regulatory summary do not create endpoints. Do not imply those workflows exist.

## ML explanation for judges

Isolation Forest provides a small, deterministic unsupervised demonstration without requiring labelled real student data. It isolates unusual programme/year aggregate patterns. Express sends `active_record_count`, `intake_ratio`, `year_over_year_change`, and `admission_year_concentration` only. Missing policy/history stays null. Institution/programme references stay in Express.

Offline NumPy-generated training data (seed 42, 800 normal rows) fit log-count transformation, median imputation/missing indicators, scaling and a 200-tree forest. The threshold is the training-score 99th percentile. A separate seeded synthetic evaluation set is never used to fit preprocessing or tune the threshold. API inference only scores a trusted locally generated artifact; no training route exists.

The score is negative `score_samples`: higher means more unusual, **not probability of fraud**. A review flag requires human investigation; no causal explanation or official identity assertion follows. Capacity ratio is correlated with deterministic intake checks, so an ML flag is not independent proof of a policy violation. Synthetic precision/recall/F1 in [the ML methodology](ml-service.md) describe deliberately extreme generated examples and do not establish real-world accuracy. Display actual runtime score/flag rather than a prepared dashboard figure.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Demo fails before readiness | Check installed binaries, free ports, running test MySQL, venv/model, locked dependencies and password length. Launcher prints no credentials or raw service logs |
| MySQL setup/startup fails | Check loopback service/config and ledger. Never switch to JSON to conceal failure. Do not overwrite existing database files |
| Login/CSRF failure | Open the exact `127.0.0.1:5173` URL; restart/sign in again after Express restart; use chosen seed password. Login rotates CSRF tokens |
| ML unavailable | `ml-start`; check model artifacts and matching private key. Normal setup needs the same ML key in both service terminals; Python does not load backend `.env` |
| QR invalid/unavailable | Preserve the same dedicated key ring across restarts; paste exact signed text. New demo runs intentionally use a new DB/key ring |
| CSV duplicate | It was already committed in this run; inspect records or start a fresh disposable demo |
| Sandbox esbuild access denied | Use the tool's approved filesystem escalation for the same command; do not count the blocked run as passed |

For independent normal local setup rather than a disposable demo, follow [README](../README.md) and [mysql.md](mysql.md). The demo launcher is not a production supervisor, durable database provisioning tool or deployment package.
