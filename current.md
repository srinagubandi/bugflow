# BugFlow Production Validation Record

**Test run:** In progress  
**Target:** Railway production service  
**Test namespace:** `qa-material3-20260812`  
**Method:** Role-based API validation with isolated production test data, followed by authenticated interface checks.

## Test matrix

| Area | Planned checks | Status |
|---|---|---|
| Platform administration | Sign in, create organization, verify cross-organization scope | Pending |
| Organization administration | Create project, create users, configure project access | Pending |
| Team member access | View assigned project, manage reports, internal comments | Pending |
| Customer access | View allowed project reports, create/edit/delete own report, customer-visible comments | Pending |
| Reporting workflow | Create report, priority, due date, status progression, assignment, duplicate linkage, labels | Pending |
| Collaboration | Customer/internal comments and visibility boundaries | Pending |
| Attachments | Upload, signed download, access boundary | Pending |
| Administration | User deactivation, audit-log visibility, soft-delete restoration | Pending |
| Notifications | Status/comment email notifications and password reset behavior | Pending |
| UX and resilience | Validation messages, authentication/session behavior, responsive Material Design interface | Pending |

## Failures and fixes

| ID | Area | Failure | Root cause | Fix | Retest status |
|---|---|---|---|---|---|
| QA-001 | Test harness | The isolated test setup stopped when creating the restricted customer returned HTTP 409. | The harness reused the same username and email for both customer test accounts. This is a test-data defect, not an application defect. | Assigned a unique account suffix to every test identity. | Fixed; complete retest pending |
| QA-002 | Authorization / test harness | The restricted-customer report-list check did not return within 90 seconds, stalling the suite. | The harness had no per-request timeout, so the underlying route behavior could not be classified. | Added a 15-second request timeout; the retest completed and the authorization route passed. | Fixed |
| QA-003 | Test harness / API coverage | Several unimplemented API paths appeared to pass because the single-page application fallback returned HTTP 200 with HTML. | The harness checked status codes without requiring JSON API payloads. | Require structured JSON for successful API calls, except intentional HTTP 204 responses, then rerun. | Pending |
| QA-004 | Notifications | Password-reset requests return HTTP 202 even when no email provider is configured, so the user receives no recovery link. | `sendBugFlowEmail` returns `{ sent: false }` but the route treats it as success; no Resend credentials or verified sender are configured. | Return a configuration error when delivery is unavailable; configure Railway with a Resend API key and verified sender, then verify with a test mailbox. | Pending |

_New failures will be added immediately and marked fixed only after a successful retest._

## Authorized Linear reference notes

| Reference area | Observed pattern | Original BugFlow adaptation |
|---|---|---|
| Global navigation | A compact, persistent left rail organizes Inbox, personal work, workspace views, and team areas. | Keep BugFlow’s Material navigation drawer but prioritize Inbox, My reports, Projects, and Views with clear role-aware grouping. |
| Issue list | Active work is grouped by status with a small count, collapsible group control, minimal row density, issue key, title, and due-date metadata. | Add status-grouped, collapsible report lists; show a concise BugFlow key, title, priority, assignee, and due-date metadata. |
| Triage controls | The page exposes focused actions for adding views, filtering, display settings, and opening a detail pane. | Add saved views, composable filters, density/display controls, and a report detail drawer while retaining BugFlow’s access-control constraints. |
| Creation affordance | The create-issue control remains immediately available in the shell and list group. | Keep a globally available report action plus contextual creation inside project/report views. |

> These are interaction and information-architecture observations from the user-authorized workspace. BugFlow will use an original Material Design implementation rather than copying Linear assets, proprietary content, or source code.

| Issue detail | Full-page detail surface combines editable title/description, activity, attachments, sub-items, subscription, and a compact right-side property stack. | Create a BugFlow report detail drawer/page with semantic property controls for status, priority, assignee, labels, project, due date, attachments, comments, and a separate internal-notes affordance. |
| Issue identity and actions | The issue key is always visible with quick copy controls, a focused work action, and an overflow menu. | Add stable per-organization BugFlow report keys, copy-link/copy-key controls, and a small action menu for duplicate, delete, restore, and subscription actions. |
| Hierarchy and activity | Sub-issues, chronological activity, and subscription are first-class but visually secondary to the report content. | Add related-report/duplicate relationships and a concise activity timeline; retain audit logging separately for administrators. |
| Properties | Status, priority, assignee, labels, and project are visible in a scannable right rail rather than hidden in forms. | Promote these BugFlow fields to a persistent property rail with permission-sensitive edit controls. |

## Improvement cycle backlog

| Cycle | Scope | Why it is prioritized | Status |
|---|---|---|---|
| 1 | API error handling for missing routes | Prevents single-page fallback HTML from disguising unsupported workflows. | Planned |
| 2 | Report detail endpoint and activity payload | Required for a Linear-inspired detail surface and verifiable comment/attachment history. | Planned |
| 3 | Customer-safe report editing | Explicitly required; enables customers to correct their own reports with full audit history. | Planned |
| 4 | Assignment and team workload controls | Required for triage and matches the property-rail workflow. | Planned |
| 5 | Label CRUD and report labeling | Required for reusable categorization and filtering. | Planned |
| 6 | Duplicate linking and related-report visibility | Required for duplicate triage and report hierarchy. | Planned |
| 7 | Audit-log and user-deactivation endpoints | Required for the defined access-control and retention model. | Planned |
| 8 | Report list filters, saved views, and detail-oriented UI | Implements the most valuable original adaptations from the authorized Linear review. | Planned |
| 9 | Email notification reliability | Ensure status/comment/reset delivery returns honest configuration errors and records notification state. | Planned |
| 10 | Full regression retest and release | Confirms all supported workflows and documents any intentional external-configuration prerequisite. | Planned |

## Completed cycles

| Cycle | Change | Validation | Result |
|---|---|---|---|
| 1 | Implemented report detail/read, reporter-safe editing, assignment, label CRUD and report labeling, duplicate links, organization user list, deactivation/reactivation, and organization audit APIs. | `pnpm build && pnpm lint` completed successfully. | Complete locally; production validation queued. |
| 2 | Added structured API-miss handling so unknown `/api` paths return JSON 404 instead of the application shell. | `pnpm build && pnpm lint` completed successfully. | Complete locally; production validation queued. |
| 3 | Made reset delivery fail honestly when email is unconfigured; added durable in-product notifications plus best-effort email delivery for customer-visible status and comment updates. | `pnpm build && pnpm lint` completed successfully. | Complete locally; production validation and Resend configuration still required. |
| 4 | Added assignment notifications and authenticated notification inbox/read APIs. | `pnpm build && pnpm lint` completed successfully. | Complete locally; production validation queued. |
| 5 | Replaced the static report panel with a live Material Design detail drawer showing editable report fields, customer/internal activity, secure attachments, labels, related reports, and a property rail. | `pnpm build && pnpm lint` completed successfully. | Complete locally; production validation queued. |
| 6 | Added secure server-side triage filters and an original grouped, collapsible Material Design triage view with status/priority filters and compact density. | `pnpm build && pnpm lint` completed successfully. | Complete locally; production validation queued. |
| 7 | Expanded the production test harness from HTTP probes to semantic assertions for detail visibility, editing, assignments, labels, duplicates, notifications, audit history, deactivation, and reset-delivery behavior. | `pnpm build && pnpm lint` completed successfully. | Ready for controlled production deployment and regression test. |


## Production regression run — 2026-08-14 (controlled branch)

**Result:** 34/46 checks passed; 12 checks failed. The failures share a likely route-contract or deployment-source root cause: report detail, report editing, assignment, notifications, labels, duplicate linkage, audit history, organization-user listing, and user activation calls returned HTTP 200 with the SPA fallback rather than a JSON API payload. The deactivated-user authentication check also failed because the preceding deactivation mutation did not return structured JSON.

**Passing coverage:** authentication; multi-organization setup; project ACL; report creation; visible and internal comment boundaries; status transitions; private attachment upload; signed downloads; soft delete and restore; priority filtering; and truthful unavailable-email behavior.

**Next cycle:** compare the live route table against the semantic QA harness paths; correct the mismatch or deployment-source issue; rebuild and redeploy; rerun all 46 checks before any new feature work.


## Production regression retest — 2026-08-14 (controlled branch)

**Result:** **49/49 checks passed; 0 failed.** The initial 12 failures were a timing issue: the first suite started before Railway had activated the controlled branch’s expanded server routes. A route probe confirmed JSON authorization responses from the new endpoints, and the complete retest passed.

**Verified end-to-end:** platform and organization authentication; organization/project/user provisioning; project ACL; team and customer access boundaries; report creation, reporting fields and list filtering; external/internal comments; status progression; attachments and signed download boundaries; soft deletion/restoration; customer-safe report detail/editing; assignment and read-state notifications; label creation/application; duplicate linking; audit history; user listing, deactivation and reactivation; and password-reset behavior when Resend is unavailable.

**External configuration prerequisite:** password-reset and customer email delivery correctly return HTTP 503 until a Resend API key and verified sender are configured. This is an intentional, truthful configuration state—not an application defect.


## UI validation defect — 2026-08-14

| ID | Area | Failure | Root cause hypothesis | Fix | Retest status |
|---|---|---|---|---|---|
| QA-005 | Report detail identity | The live Material Design report drawer rendered the breadcrumb as `BF-undefined` even though the report row correctly displayed `BF-1`. | The client detail header likely uses a non-existent `number` property instead of the API’s `sequence` field. | Pending targeted client-field correction. | Pending |
| QA-005 | Report detail identity | `BF-undefined` appeared in the live detail drawer. | Detail SQL returned `sequence_number` but the client contract uses `sequenceNumber`. | Added explicit `r.sequence_number AS "sequenceNumber"` to the detail query; build and lint pass. | Pending controlled deploy and UI retest |
| QA-006 | Report detail activity UI | Posting a customer-visible update in the live detail drawer navigated the browser to `/?body=...&visibility=customer`, reset the current project context, and did not keep the report drawer open. | The detail form submission is falling through to native browser submission rather than being prevented and routed through the asynchronous comment handler. | Pending targeted form-handler correction and live retest. | Pending |
| QA-006 | Report detail activity UI | Activity form navigated natively because it was nested inside the report-edit form. | Invalid nested HTML forms caused browser submission behavior to bypass the intended asynchronous handler. | Separated the report-edit and activity forms; build and lint pass. | Pending controlled deploy and UI retest |
| QA-007 | Report detail activity UI | After separating forms, posting an update raised `Cannot read properties of null (reading 'reset')` and did not refresh activity. | The asynchronous handler accessed React’s `event.currentTarget` after an awaited API call, when the event target was no longer available. | Pending capture of the form element before awaiting the API call. | Pending |
| QA-007 | Report detail activity UI | Comment submission attempted to reset a null event target after the API call. | React event target was accessed after an await. | Captured the form element before awaiting and reset that retained element; build and lint pass. | Pending controlled deploy and UI retest |


## Live UI retest — 2026-08-14

**Result:** Passed. The controlled QA report now displays `BF-1` consistently in the list, drawer header, and detail breadcrumb. The customer-visible activity form remains in the drawer, clears after submission, and appends the new update to the live activity timeline without navigation or error.

**Fixed defects:** QA-005, QA-006, and QA-007 are verified fixed in the deployed `feature/linear-workflow-qa` branch.


## Final production regression — 2026-08-14

**Result:** **49/49 checks passed; 0 failed.** This final isolated production run followed the live UI report-code and activity-form retests. All supported API workflows remain healthy with PostgreSQL and private attachment storage ready.

**Email note:** Password-reset and customer email delivery are intentionally reported as unavailable until Railway receives a Resend API key and a verified sender identity. The application returns an explicit HTTP 503 instead of falsely claiming an email was sent.


## v0.4.0 expansion plan — 2026-08-14

**Approved scope:** Build priorities 1–4: Resend email delivery configuration, an administrator workspace, triage productivity improvements, customer portal enhancements, and an administrator-managed backup service.

**Backup architecture selected:** **Managed backup service.** A short-lived Railway job will perform one-time and recurring logical PostgreSQL exports, place private archives in the existing Railway bucket, and record status/history in BugFlow. The application will expose global administrator controls for one-time, weekly, and monthly backup policies. Recurrence will be evaluated by the worker so administrators can change policy without directly editing Railway’s cron configuration.

**Delivery prerequisite:** External email cannot be live-tested until the Railway environment contains a Resend API key and verified sender identity. Product behavior will continue to return explicit configuration errors until those values are present.


### v0.4.0 implementation cycle 1

**Completed:** Added versioned schema support for backup policy/history, saved views, report subscriptions, and release notes; created the private Railway backup worker and archive helper; added platform backup policy/history/manual-run APIs; added saved-view, bulk triage, subscription, duplicate-suggestion, and release-note APIs.

**Validation:** `pnpm build && pnpm lint` passed after correcting the Zod v4 saved-view record schema.


### Backup design references

- Railway PostgreSQL guidance recommends regular backups: https://docs.railway.com/databases/postgresql
- Railway cron jobs are suitable for short-lived tasks such as database backups and use UTC schedules: https://docs.railway.com/cron-jobs
- Railway native volume backups provide manual, weekly, and monthly snapshots, but the selected BugFlow-managed service controls logical export scheduling inside the product: https://docs.railway.com/volumes/backups


## Railway backup-worker deployment reference — 2026-08-14

- The `feature/admin-backups-portal` branch includes `railway.backup.toml`, a Dockerfile-backed Railway cron configuration for the managed backup worker.
- Railway configuration reference: https://docs.railway.com/config-as-code/reference
- Railway cron-service reference: https://docs.railway.com/cron-jobs
- The worker is configured on a 15-minute UTC cron tick. It exits after evaluating the policy; the application determines whether a pending one-time, weekly, or monthly backup is due.
- The backup worker receives only its `DATABASE_URL` and the private object-storage references `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `ENDPOINT`, `REGION=auto`, and `S3_FORCE_PATH_STYLE=false`. No public networking is configured.


### v0.4.0 backup-worker runtime validation

- **Failure observed:** The Railway backup-worker image deployed successfully after adding the trusted pnpm build approval, but the first manually triggered cron execution started a container and then crashed after roughly one minute without producing a worker log line.
- **Likely root cause under investigation:** the logical dump process may be waiting for PostgreSQL authentication rather than receiving the Railway connection credential in a form `pg_dump` uses non-interactively.
- **Next fix:** parse the Railway connection URL, pass explicit host, port, username, database name, password, and SSL mode to `pg_dump`, and add a bounded timeout/error path before retesting the one-time archive workflow.

- **Fix applied:** The worker now parses `DATABASE_URL`, supplies `PGPASSWORD`, host, port, username, database name, and explicit SSL mode to `pg_dump`, and terminates a stalled dump after 90 seconds with a diagnostic error.
- **Local validation:** `pnpm build && pnpm lint` passed after the worker change. The focused worker retest is ready for deployment.

## Managed backup worker runtime defect — 2026-08-14

| ID | Area | Failure | Root cause | Fix | Retest status |
|---|---|---|---|---|---|
| QA-008 | Managed backup worker | A manually triggered one-time backup was claimed but failed before archive upload. | Railway PostgreSQL runs **18.4**, while the worker Docker image installed `pg_dump` **15.19**; logical dump clients must not be older than the server. | Pin the worker image to PostgreSQL 18 client tooling, rebuild, redeploy, and rerun the queued backup. | In progress |

No archive was created and the application database, attachment bucket, and application service remain unchanged.


**QA-008 update:** The backup worker Dockerfile now installs the PostgreSQL 18 client from the official PostgreSQL apt repository. `pnpm build && pnpm lint` passed locally; the controlled Railway redeployment and one-time backup retest are next.


## v0.4.0 expanded production regression — 2026-08-14

**Result:** **69/69 checks passed; 0 failed.** Coverage now includes the prior role-based workflows plus platform backup settings/history, weekly and monthly policy selection, one-time backup queueing behavior, private and shared saved views, bulk triage updates, subscriptions, duplicate suggestions, and customer release-note draft/publish/visibility flows.

**Backup note:** The manual backup API correctly returns HTTP 409 while the PostgreSQL 18 worker retest is already queued. Archive completion remains the final pending infrastructure validation for QA-008.


### QA-008 final retest — 2026-08-14

**Result:** Passed. The managed Railway backup worker processed the queued one-time backup successfully using the PostgreSQL 18 client. It created the private archive `platform/backups/2026/08/bugflow-2026-08-14T22-16-30-495Z-c51b4488-fafa-4e70-9f8a-68e45cdd02ce.dump` with a recorded size of **101,075 bytes** and SHA-256 checksum `c10afdae90d1b669207600f37acb4198bc2a6d17093c6b4860dbfb9a19bf3654`.

**Status:** QA-008 is fixed. One-time, weekly, and monthly policy handling is available through the platform administrator workspace; weekly/monthly execution uses the Railway worker’s 15-minute UTC policy-evaluation tick.


### QA-009 — Railway application build configuration

**Failure:** The `bugflow-app` deployment on `feature/admin-backups-portal` failed during `pnpm install --frozen-lockfile --prefer-offline` with `ERROR packages field missing or empty` after the backup-worker approval file was added.

**Root cause:** `pnpm-workspace.yaml` contained `allowBuilds` but no `packages` definition. Railpack correctly treated it as a workspace manifest and required at least one package path.

**Fix:** Added `packages: ['.']` alongside the existing trusted `esbuild` approval. A Railway-equivalent frozen install, production build, and strict type check now pass locally. Controlled redeployment is pending.


### QA-009 final retest — 2026-08-14

**Result:** Passed. Railway built and deployed the corrected feature branch successfully after adding the root package definition to `pnpm-workspace.yaml`. The live health endpoint returned HTTP 200 with private storage configured, and the expanded production regression suite passed **70/70** checks with no failures.

