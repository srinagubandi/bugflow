const base = process.env.BUGFLOW_BASE_URL || 'https://bugflow-app-production.up.railway.app';
const password = process.env.QA_PLATFORM_PASSWORD;
if (!password) throw new Error('QA_PLATFORM_PASSWORD is required.');

async function request(path, options = {}, cookie = null) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('Cookie', cookie);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${base}${path}`, { ...options, headers, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${body?.error || 'Unknown error'}`);
  return { body, cookie: response.headers.get('set-cookie')?.split(';')[0] || null };
}

const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: 'bugflow-admin', password }) });
const session = await request('/api/auth/session', {}, login.cookie);
const organization = session.body.organizations?.[0];
if (!organization) throw new Error('No accessible organization found.');
const reports = await request(`/api/organizations/${organization.id}/reports`, {}, login.cookie);
const report = reports.body.reports?.find((item) => item.title === '[Sample media] Internal status refresh mismatch');
if (!report) throw new Error('Corrected internal-client sample report was not found.');
const detail = await request(`/api/reports/${report.id}`, {}, login.cookie);
const attachmentTypes = (detail.body.attachments || []).map((item) => item.contentType).sort();
if (report.status !== 'resolved') throw new Error(`Sample report is ${report.status}, expected resolved.`);
if (!Number.isFinite(report.sequenceNumber)) throw new Error('Sample report is missing its visible BugFlow sequence number.');
if (attachmentTypes.join(',') !== 'image/png,video/mp4') throw new Error(`Unexpected attachment types: ${attachmentTypes.join(', ') || 'none'}`);
console.log(JSON.stringify({ report: report.title, reportCode: `BF-${report.sequenceNumber}`, status: report.status, attachmentCount: attachmentTypes.length, attachmentTypes }, null, 2));
