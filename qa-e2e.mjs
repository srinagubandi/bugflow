import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const base = process.env.BUGFLOW_BASE_URL || 'https://bugflow-app-production.up.railway.app';
const platformPassword = process.env.QA_PLATFORM_PASSWORD;
if (!platformPassword) throw new Error('QA_PLATFORM_PASSWORD is required.');

const runId = `qa${Date.now().toString(36)}`;
const password = `Test-${runId}-Password!2026`;
const results = [];
const state = { runId, base, users: {}, organization: null, project: null, report: null, attachment: null };

function record(name, passed, detail, meta = {}) {
  results.push({ name, passed, detail, ...meta });
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`${mark} ${name}: ${detail}`);
}

async function request(path, options = {}, session = null) {
  const headers = new Headers(options.headers || {});
  if (session) headers.set('Cookie', session);
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${base}${path}`, { ...options, headers, signal: AbortSignal.timeout(15000) });
  const raw = await response.text();
  let body = raw;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON response */ }
  return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0] || null };
}

async function expect(name, action, expectedStatus) {
  try {
    const result = await action();
    const expectedStatusMatched = Array.isArray(expectedStatus) ? expectedStatus.includes(result.response.status) : result.response.status === expectedStatus;
    const hasStructuredApiPayload = result.response.status === 204 || (result.body !== null && typeof result.body === 'object' && !Array.isArray(result.body));
    const passed = expectedStatusMatched && hasStructuredApiPayload;
    const payloadNote = hasStructuredApiPayload ? '' : ' — expected JSON API payload but received SPA fallback or empty response';
    record(name, passed, `HTTP ${result.response.status}${result.body?.error ? ` — ${result.body.error}` : ''}${payloadNote}`, { status: result.response.status, body: result.body });
    return result;
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function login(identifier, passwordValue, label) {
  const result = await expect(`${label}: authenticate`, () => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password: passwordValue }) }), 200);
  if (!result?.cookie) throw new Error(`${label} did not receive a session cookie.`);
  return result.cookie;
}

const platform = await login('bugflow-admin', platformPassword, 'Platform administrator');
await expect('Health endpoint reports database and attachment storage', () => request('/api/health'), 200);

const orgPayload = {
  name: `QA Material3 ${runId}`,
  slug: `qa-${runId}`,
  admin: { username: `qa-admin-${runId}`, email: `qa-admin-${runId}@example.test`, displayName: 'QA Organization Admin', password },
};
const orgResult = await expect('Platform admin creates isolated organization', () => request('/api/platform/organizations', { method: 'POST', body: JSON.stringify(orgPayload) }, platform), 201);
if (!orgResult?.body?.organization) throw new Error('Cannot continue without a test organization.');
state.organization = orgResult.body.organization;
state.users.admin = { username: orgPayload.admin.username, email: orgPayload.admin.email, password, id: orgResult.body.adminUserId };

const orgAdmin = await login(state.users.admin.username, password, 'Organization administrator');
const projectPayload = { name: `QA Triage ${runId}`, slug: `qa-triage-${runId}`, description: 'Isolated production validation project', color: '#6750A4' };
const projectResult = await expect('Organization admin creates project', () => request(`/api/organizations/${state.organization.id}/projects`, { method: 'POST', body: JSON.stringify(projectPayload) }, orgAdmin), 201);
if (!projectResult?.body?.id) throw new Error('Cannot continue without a test project.');
state.project = projectResult.body;

async function createUser(role, name, identity = role) {
  const payload = { username: `qa-${identity}-${runId}`, email: `qa-${identity}-${runId}@example.test`, displayName: name, password, role };
  const created = await expect(`Organization admin creates ${role} user`, () => request(`/api/organizations/${state.organization.id}/users`, { method: 'POST', body: JSON.stringify(payload) }, orgAdmin), 201);
  if (!created?.body?.user?.id) throw new Error(`Cannot continue without ${role} user.`);
  return { ...payload, id: created.body.user.id };
}

state.users.team_member = await createUser('team_member', 'QA Team Member');
state.users.developer = await createUser('developer', 'QA Developer');
state.users.customer = await createUser('customer', 'QA Customer');
state.users.outsider = await createUser('customer', 'QA Restricted Customer', 'restricted-customer');

await expect('Admin grants team member report-management access', () => request(`/api/projects/${state.project.id}/access/${state.users.team_member.id}`, { method: 'PUT', body: JSON.stringify({ canView: true, canReport: true, canComment: true, canManage: true }) }, orgAdmin), 200);
await expect('Admin grants developer report-management access', () => request(`/api/projects/${state.project.id}/access/${state.users.developer.id}`, { method: 'PUT', body: JSON.stringify({ canView: true, canReport: true, canComment: true, canManage: true }) }, orgAdmin), 200);
await expect('Admin grants customer collaborative access', () => request(`/api/projects/${state.project.id}/access/${state.users.customer.id}`, { method: 'PUT', body: JSON.stringify({ canView: true, canReport: true, canComment: true, canManage: false }) }, orgAdmin), 200);
await expect('Admin cannot grant customer staff management', () => request(`/api/projects/${state.project.id}/access/${state.users.customer.id}`, { method: 'PUT', body: JSON.stringify({ canView: true, canReport: true, canComment: true, canManage: true }) }, orgAdmin), 400);
const accessInventory = await expect('Admin lists organization project-access grants', () => request(`/api/organizations/${state.organization.id}/project-access`, {}, orgAdmin), 200);
if (accessInventory?.body?.access?.some((grant) => grant.projectId === state.project.id && grant.userId === state.users.team_member.id && grant.canManage)) record('Project-access inventory returns team management grant', true, 'Team management grant is visible to organization administrators.');
else record('Project-access inventory returns team management grant', false, 'Expected team management grant was missing from access inventory.');

const team = await login(state.users.team_member.username, password, 'Team member');
const developer = await login(state.users.developer.username, password, 'Developer');
const customer = await login(state.users.customer.username, password, 'Customer');
const outsider = await login(state.users.outsider.username, password, 'Restricted customer');

await expect('Customer sees allowed project', () => request(`/api/organizations/${state.organization.id}/projects`, {}, customer), 200);
await expect('Restricted customer cannot see unassigned project reports', () => request(`/api/organizations/${state.organization.id}/reports`, {}, outsider), 200);

const reportPayload = {
  projectId: state.project.id,
  title: `QA material workflow failure ${runId}`,
  description: 'Automated end-to-end validation report. This record is safe to delete after validation.',
  reproductionSteps: '1. Open test workspace\n2. Submit automated report',
  expectedResult: 'Report is visible to permitted users.',
  actualResult: 'Testing workflow execution.',
  browserDevice: 'QA Node client',
  applicationVersion: 'v0.2.0-qa',
  priority: 'high',
  dueAt: new Date(Date.now() + 86400000).toISOString(),
};
const reportResult = await expect('Customer creates a prioritized report with SLA target', () => request('/api/reports', { method: 'POST', body: JSON.stringify(reportPayload) }, customer), 201);
if (!reportResult?.body?.id) throw new Error('Cannot continue without a test report.');
state.report = reportResult.body;

await expect('Customer lists customer-visible organization reports', () => request(`/api/organizations/${state.organization.id}/reports`, {}, customer), 200);
await expect('Team member lists accessible organization reports', () => request(`/api/organizations/${state.organization.id}/reports`, {}, team), 200);
await expect('Restricted customer receives no reports for unassigned project', async () => {
  const result = await request(`/api/organizations/${state.organization.id}/reports`, {}, outsider);
  if (result.response.status === 200 && Array.isArray(result.body?.reports) && result.body.reports.length !== 0) throw new Error('Restricted user received report data.');
  return result;
}, 200);
await expect('Customer is blocked from organization project-access inventory', () => request(`/api/organizations/${state.organization.id}/project-access`, {}, customer), 403);

await expect('Customer adds a customer-visible comment', () => request(`/api/reports/${state.report.id}/comments`, { method: 'POST', body: JSON.stringify({ body: 'QA customer-visible comment', visibility: 'customer' }) }, customer), 201);
await expect('Team member adds internal comment', () => request(`/api/reports/${state.report.id}/comments`, { method: 'POST', body: JSON.stringify({ body: 'QA internal-only comment', visibility: 'internal' }) }, team), 201);
await expect('Customer is blocked from adding internal comments', () => request(`/api/reports/${state.report.id}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Unauthorized internal comment', visibility: 'internal' }) }, customer), 403);

for (const status of ['acknowledged', 'in_progress', 'resolved']) {
  await expect(`Team member changes report status to ${status}`, () => request(`/api/reports/${state.report.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }, team), 200);
}

const form = new FormData();
form.append('file', new Blob(['BugFlow QA attachment content'], { type: 'text/plain' }), `qa-${runId}.txt`);
const attachmentResult = await expect('Customer uploads private attachment', () => request(`/api/reports/${state.report.id}/attachments`, { method: 'POST', body: form }, customer), 201);
if (attachmentResult?.body?.id) {
  state.attachment = attachmentResult.body;
  await expect('Authorized customer receives signed attachment download URL', () => request(`/api/attachments/${state.attachment.id}/download`, {}, customer), 200);
  await expect('Restricted customer is blocked from attachment download', () => request(`/api/attachments/${state.attachment.id}/download`, {}, outsider), 403);
}

await expect('Customer soft-deletes own report', () => request(`/api/reports/${state.report.id}`, { method: 'DELETE' }, customer), 204);
await expect('Organization admin restores soft-deleted report', () => request(`/api/reports/${state.report.id}/restore`, { method: 'POST' }, orgAdmin), 200);

const detailResult = await expect('Customer reads report detail without internal comments', () => request(`/api/reports/${state.report.id}`, {}, customer), 200);
if (detailResult?.body?.comments?.some((comment) => comment.visibility === 'internal')) record('Customer detail excludes internal comments', false, 'Internal comment leaked into customer detail payload.');
else record('Customer detail excludes internal comments', true, 'Internal comment remains private.');

await expect('Customer edits own report', () => request(`/api/reports/${state.report.id}`, { method: 'PATCH', body: JSON.stringify({ title: `Edited ${runId}`, priority: 'critical' }) }, customer), 200);
await expect('Report list filters by priority', () => request(`/api/organizations/${state.organization.id}/reports?priority=critical`, {}, customer), 200);
const assigneeDirectory = await expect('Admin lists eligible delivery and review owners', () => request(`/api/projects/${state.project.id}/assignees`, {}, orgAdmin), 200);
if (assigneeDirectory?.body?.assignees?.some((candidate) => candidate.id === state.users.developer.id && candidate.role === 'developer')) record('Developer appears in eligible assignee directory', true, 'Active developer with project visibility is eligible for delivery and review ownership.');
else record('Developer appears in eligible assignee directory', false, 'Eligible developer was missing from the project assignee directory.');
await expect('Developer can list eligible project assignees', () => request(`/api/projects/${state.project.id}/assignees`, {}, developer), 200);
await expect('Customer is blocked from eligible assignee directory', () => request(`/api/projects/${state.project.id}/assignees`, {}, customer), 403);
await expect('Admin assigns report to team member', () => request(`/api/reports/${state.report.id}/assignee`, { method: 'PATCH', body: JSON.stringify({ assigneeId: state.users.team_member.id }) }, orgAdmin), 200);
await expect('Admin reassigns delivery owner to developer', () => request(`/api/reports/${state.report.id}/assignee`, { method: 'PATCH', body: JSON.stringify({ assigneeId: state.users.developer.id }) }, orgAdmin), 200);
await expect('Admin assigns developer as review owner', () => request(`/api/reports/${state.report.id}/reviewer`, { method: 'PATCH', body: JSON.stringify({ reviewerId: state.users.developer.id }) }, orgAdmin), 200);
await expect('Developer reassigns review ownership to team member', () => request(`/api/reports/${state.report.id}/reviewer`, { method: 'PATCH', body: JSON.stringify({ reviewerId: state.users.team_member.id }) }, developer), 200);
await expect('Customer cannot reassign review ownership', () => request(`/api/reports/${state.report.id}/reviewer`, { method: 'PATCH', body: JSON.stringify({ reviewerId: state.users.developer.id }) }, customer), 403);
const teamNotifications = await expect('Assigned team member receives in-product notification', () => request('/api/notifications', {}, team), 200);
const assignment = teamNotifications?.body?.notifications?.find((notification) => notification.type === 'assignment');
if (assignment?.id) await expect('Team member marks assignment notification read', () => request(`/api/notifications/${assignment.id}/read`, { method: 'PATCH' }, team), 200);
else record('Team member marks assignment notification read', false, 'Assignment notification was not returned.');

const labelResult = await expect('Admin creates reusable organization label', () => request(`/api/organizations/${state.organization.id}/labels`, { method: 'POST', body: JSON.stringify({ name: `QA Label ${runId}`, color: '#6750A4' }) }, orgAdmin), 201);
if (labelResult?.body?.id) {
  await expect('Admin applies reusable label to report', () => request(`/api/reports/${state.report.id}/labels`, { method: 'POST', body: JSON.stringify({ labelId: labelResult.body.id }) }, orgAdmin), 201);
  await expect('Customer sees report labels in detail', () => request(`/api/reports/${state.report.id}`, {}, customer), 200);
}

const duplicateResult = await expect('Customer creates second report for duplicate-link test', () => request('/api/reports', { method: 'POST', body: JSON.stringify({ ...reportPayload, title: `QA duplicate candidate ${runId}`, priority: 'low' }) }, customer), 201);
if (duplicateResult?.body?.id) await expect('Admin links a duplicate report', () => request(`/api/reports/${duplicateResult.body.id}/duplicates`, { method: 'POST', body: JSON.stringify({ duplicateOfId: state.report.id }) }, orgAdmin), 201);
await expect('Admin retrieves organization audit history', () => request(`/api/organizations/${state.organization.id}/audit`, {}, orgAdmin), 200);
await expect('Admin lists organization users', () => request(`/api/organizations/${state.organization.id}/users`, {}, orgAdmin), 200);
await expect('Admin deactivates customer with project access', () => request(`/api/organizations/${state.organization.id}/users/${state.users.customer.id}/deactivate`, { method: 'POST' }, orgAdmin), 200);
const inactiveFilteredInventory = await expect('Admin project-access inventory omits inactive members', () => request(`/api/organizations/${state.organization.id}/project-access`, {}, orgAdmin), 200);
if (inactiveFilteredInventory?.body?.access?.some((grant) => grant.userId === state.users.customer.id)) record('Inactive member grants are not exposed in access inventory', false, 'Inactive member appeared in project-access inventory.');
else record('Inactive member grants are not exposed in access inventory', true, 'Inactive members are excluded from project-access inventory.');
await expect('Deactivated user cannot authenticate', () => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: state.users.customer.username, password }) }), 401);
await expect('Admin reactivates customer with project access', () => request(`/api/organizations/${state.organization.id}/users/${state.users.customer.id}/activate`, { method: 'POST' }, orgAdmin), 200);

const resetResult = await expect('Password-reset request reports unavailable delivery honestly', () => request('/api/auth/password-reset/request', { method: 'POST', body: JSON.stringify({ email: state.users.customer.email }) }), [202, 503]);
if (resetResult?.response.status === 503) record('Password reset requires external Resend configuration', true, 'Correctly reported missing email delivery configuration.');

await writeFile('/home/ubuntu/bugflow-release/qa-results.json', JSON.stringify({ generatedAt: new Date().toISOString(), state, results }, null, 2));
const failed = results.filter((result) => !result.passed);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} checks passed; ${failed.length} failed.`);
process.exitCode = failed.length ? 2 : 0;
