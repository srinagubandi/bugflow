import { readFile } from 'node:fs/promises';

const base = process.env.BUGFLOW_BASE_URL || 'https://bugflow-app-production.up.railway.app';
const password = process.env.QA_PLATFORM_PASSWORD;
if (!password) throw new Error('QA_PLATFORM_PASSWORD is required.');

async function request(path, options = {}, cookie = null) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('Cookie', cookie);
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${base}${path}`, { ...options, headers, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${body?.error || text || 'Unknown error'}`);
  return { body, cookie: response.headers.get('set-cookie')?.split(';')[0] || null };
}

const login = await request('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ identifier: 'bugflow-admin', password }),
});
if (!login.cookie) throw new Error('Login did not return a session cookie.');

const session = await request('/api/auth/session', {}, login.cookie);
const organization = session.body.organizations?.[0];
if (!organization) throw new Error('No accessible organization was found for the platform administrator.');
const projectList = await request(`/api/organizations/${organization.id}/projects`, {}, login.cookie);
const project = projectList.body.projects?.[0];
if (!project) throw new Error(`No accessible project was found for ${organization.name}.`);

const reportList = await request(`/api/organizations/${organization.id}/reports`, {}, login.cookie);
const obsoleteReports = (reportList.body.reports || []).filter((item) => item.title === '[Sample media] Checkout payment error evidence');
for (const obsolete of obsoleteReports) await request(`/api/reports/${obsolete.id}`, { method: 'DELETE' }, login.cookie);

const report = await request('/api/reports', {
  method: 'POST',
  body: JSON.stringify({
    projectId: project.id,
    title: '[Sample media] Internal status refresh mismatch',
    description: 'Synthetic demonstration report created by BugFlow’s UI/UX validation workflow. The attached screenshot and eight-second reproduction clip are fictional evidence for a client/internal, administrator-created, login-only application. No public signup, checkout, or payment flow is represented.',
    reproductionSteps: '1. Sign in with an administrator-created internal account.\n2. Open a fictional client case workspace.\n3. Change a case status to Awaiting approval.\n4. Observe that the detail pane updates while the list briefly remains stale.',
    expectedResult: 'The internal case list and case detail should reflect the same status immediately after a status change.',
    actualResult: 'The internal case detail updates while the associated list row temporarily remains stale and shows an inline refresh warning.',
    browserDevice: 'Sample desktop browser',
    applicationVersion: 'BugFlow sample media',
    priority: 'low',
  }),
}, login.cookie);

const media = [
  { path: '/home/ubuntu/bugflow-uiux/sample-media/internal-client-status-refresh-defect.png', name: 'sample-internal-status-refresh-defect.png', type: 'image/png' },
  { path: '/home/ubuntu/bugflow-uiux/sample-media/internal-client-status-refresh-defect-repro.mp4', name: 'sample-internal-status-refresh-defect-repro.mp4', type: 'video/mp4' },
];

for (const item of media) {
  const bytes = await readFile(item.path);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: item.type }), item.name);
  await request(`/api/reports/${report.body.id}/attachments`, { method: 'POST', body: form }, login.cookie);
}

await request(`/api/reports/${report.body.id}/status`, {
  method: 'PATCH',
  body: JSON.stringify({ status: 'resolved' }),
}, login.cookie);

console.log(JSON.stringify({
  result: 'created',
  obsoleteCheckoutSamplesSoftDeleted: obsoleteReports.length,
  organization: organization.name,
  project: project.name,
  reportId: report.body.id,
  reportCode: `BF-${report.body.sequenceNumber}`,
  attachments: media.map(({ name }) => name),
  status: 'resolved',
}, null, 2));
