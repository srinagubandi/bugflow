import 'dotenv/config';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { z } from 'zod';
import { query, withTransaction, writeAuditEvent } from './db.js';
import { reportUpdateEmail, sendBugFlowEmail } from './email.js';
import { attachmentKey, signedAttachmentUrl, storageIsConfigured, uploadAttachment } from './storage.js';

type CurrentUser = {
  id: string;
  isPlatformAdmin: boolean;
  username: string;
  email: string;
  displayName: string;
};

type AppRequest = Request & { currentUser?: CurrentUser };

const app = express();
const port = Number(process.env.PORT ?? 8080);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? false, credentials: true }));
app.use(express.json({ limit: '1mb' }));

function clientIp(request: Request) {
  return request.ip || request.socket.remoteAddress || null;
}

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const derived = scryptSync(password, salt, 64).toString('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(derived, 'hex'));
}

function sessionTokenFrom(request: Request) {
  const bearer = request.header('authorization');
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7);
  const cookie = request.header('cookie') ?? '';
  const entry = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('bugflow_session='));
  return entry?.split('=').slice(1).join('=');
}

async function authenticate(request: AppRequest, response: Response, next: NextFunction) {
  const token = sessionTokenFrom(request);
  if (!token) return next();

  try {
    const result = await query<CurrentUser>(
      `SELECT u.id, u.is_platform_admin AS "isPlatformAdmin", u.username, u.email, u.display_name AS "displayName"
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active = true AND u.deleted_at IS NULL`,
      [hashToken(token)],
    );
    request.currentUser = result.rows[0];
  } catch (error) {
    console.error('Authentication lookup failed', error);
  }
  next();
}

app.use(authenticate);

function requireUser(request: AppRequest, response: Response): CurrentUser | null {
  if (!request.currentUser) {
    response.status(401).json({ error: 'Authentication is required.' });
    return null;
  }
  return request.currentUser;
}

async function organizationRole(userId: string, organizationId: string) {
  const result = await query<{ role: 'admin' | 'team_member' | 'customer' }>(
    `SELECT role FROM memberships WHERE user_id = $1 AND organization_id = $2 AND is_active = true`,
    [userId, organizationId],
  );
  return result.rows[0]?.role ?? null;
}

async function checkProjectAccess(user: CurrentUser, projectId: string, action: 'view' | 'report' | 'comment' | 'manage') {
  const project = await query<{ organization_id: string }>('SELECT organization_id FROM projects WHERE id = $1 AND is_active = true AND deleted_at IS NULL', [projectId]);
  if (!project.rowCount) return { allowed: false, organizationId: null } as const;
  const organizationId = project.rows[0].organization_id;
  if (user.isPlatformAdmin) return { allowed: true, organizationId } as const;

  const role = await organizationRole(user.id, organizationId);
  if (!role) return { allowed: false, organizationId } as const;
  if (role === 'admin') return { allowed: true, organizationId } as const;

  const column = action === 'view' ? 'can_view' : action === 'report' ? 'can_report' : action === 'comment' ? 'can_comment' : 'can_manage';
  const access = await query<{ allowed: boolean }>(`SELECT ${column} AS allowed FROM project_access WHERE project_id = $1 AND user_id = $2`, [projectId, user.id]);
  return { allowed: Boolean(access.rows[0]?.allowed), organizationId } as const;
}

async function reportAccess(user: CurrentUser, reportId: string, action: 'view' | 'comment' | 'manage') {
  const report = await query<{ project_id: string; organization_id: string; reporter_id: string; deleted_at: string | null }>(
    'SELECT project_id, organization_id, reporter_id, deleted_at FROM reports WHERE id = $1',
    [reportId],
  );
  if (!report.rowCount) return { allowed: false, report: null } as const;
  const item = report.rows[0];
  const access = await checkProjectAccess(user, item.project_id, action === 'manage' ? 'manage' : action);
  if (!access.allowed || (item.deleted_at && action !== 'manage')) return { allowed: false, report: item } as const;
  return { allowed: true, report: item } as const;
}

const loginSchema = z.object({ identifier: z.string().min(1), password: z.string().min(8) });
const organizationSchema = z.object({ name: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]+$/), admin: z.object({ username: z.string().min(3).max(60), email: z.string().email(), displayName: z.string().min(2).max(120), password: z.string().min(12).max(200) }) });
const projectSchema = z.object({ name: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]+$/), description: z.string().max(500).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#8176ff') });
const organizationUserSchema = z.object({ username: z.string().min(3).max(60), email: z.string().email(), displayName: z.string().min(2).max(120), password: z.string().min(12).max(200), role: z.enum(['admin', 'team_member', 'customer']) });
const projectAccessSchema = z.object({ canView: z.boolean().default(true), canReport: z.boolean().default(true), canComment: z.boolean().default(true), canManage: z.boolean().default(false) });
const reportSchema = z.object({ projectId: z.string().uuid(), title: z.string().min(4).max(240), description: z.string().min(4).max(20000), reproductionSteps: z.string().max(20000).optional(), expectedResult: z.string().max(20000).optional(), actualResult: z.string().max(20000).optional(), browserDevice: z.string().max(500).optional(), applicationVersion: z.string().max(200).optional(), priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'), dueAt: z.string().datetime().optional() });
const commentSchema = z.object({ body: z.string().min(1).max(20000), visibility: z.enum(['customer', 'internal']).default('customer') });

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', service: 'bugflow', storageConfigured: storageIsConfigured(), timestamp: new Date().toISOString() });
});

app.post('/api/auth/login', async (request: AppRequest, response) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide a valid username/email and password.' });
  try {
    const result = await query<{ id: string; username: string; email: string; display_name: string; password_hash: string; is_platform_admin: boolean }>(
      `SELECT id, username, email, display_name, password_hash, is_platform_admin FROM users
       WHERE (username = $1 OR email = $1) AND is_active = true AND deleted_at IS NULL`,
      [parsed.data.identifier],
    );
    const account = result.rows[0];
    if (!account || !verifyPassword(parsed.data.password, account.password_hash)) {
      await writeAuditEvent({ entityType: 'authentication', action: 'login_failed', metadata: { identifier: parsed.data.identifier }, ipAddress: clientIp(request) });
      return response.status(401).json({ error: 'Invalid sign-in details.' });
    }
    const token = randomBytes(32).toString('base64url');
    await query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval \'14 days\')', [account.id, hashToken(token)]);
    await writeAuditEvent({ actorId: account.id, entityType: 'authentication', action: 'login_succeeded', ipAddress: clientIp(request) });
    response.setHeader('Set-Cookie', `bugflow_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600`);
    return response.json({ user: { id: account.id, username: account.username, email: account.email, displayName: account.display_name, isPlatformAdmin: account.is_platform_admin } });
  } catch (error) {
    return response.status(503).json({ error: 'Authentication is temporarily unavailable.' });
  }
});

app.post('/api/auth/logout', async (request: AppRequest, response) => {
  const token = sessionTokenFrom(request);
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  response.setHeader('Set-Cookie', 'bugflow_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  response.status(204).end();
});

app.post('/api/platform/organizations', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  if (!actor.isPlatformAdmin) return response.status(403).json({ error: 'Platform administrator access is required.' });
  const parsed = organizationSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide valid organization and admin information.' });

  try {
    const created = await withTransaction(async (client) => {
      const org = await client.query<{ id: string; name: string; slug: string }>('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug', [parsed.data.name, parsed.data.slug]);
      const user = await client.query<{ id: string }>(`INSERT INTO users (username, email, display_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`, [parsed.data.admin.username, parsed.data.admin.email, parsed.data.admin.displayName, hashPassword(parsed.data.admin.password)]);
      await client.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, \'admin\')', [org.rows[0].id, user.rows[0].id]);
      return { organization: org.rows[0], adminUserId: user.rows[0].id };
    });
    await writeAuditEvent({ actorId: actor.id, organizationId: created.organization.id, entityType: 'organization', entityId: created.organization.id, action: 'organization_created', metadata: { slug: created.organization.slug }, ipAddress: clientIp(request) });
    return response.status(201).json(created);
  } catch (error) {
    return response.status(409).json({ error: 'That organization, username, or email already exists.' });
  }
});

app.post('/api/organizations/:organizationId/projects', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  const parsed = projectSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide valid project details.' });

  try {
    const result = await query(`INSERT INTO projects (organization_id, name, slug, description, color) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [organizationId, parsed.data.name, parsed.data.slug, parsed.data.description ?? null, parsed.data.color]);
    await writeAuditEvent({ organizationId, actorId: actor.id, entityType: 'project', entityId: result.rows[0].id, action: 'project_created', metadata: { name: parsed.data.name }, ipAddress: clientIp(request) });
    return response.status(201).json(result.rows[0]);
  } catch (error) {
    return response.status(409).json({ error: 'A project with that slug already exists.' });
  }
});

app.post('/api/organizations/:organizationId/users', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  const parsed = organizationUserSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide valid user, password, and role details.' });

  try {
    const created = await withTransaction(async (client) => {
      const user = await client.query<{ id: string; username: string; email: string; display_name: string }>(
        `INSERT INTO users (username, email, display_name, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, email, display_name`,
        [parsed.data.username, parsed.data.email, parsed.data.displayName, hashPassword(parsed.data.password)],
      );
      await client.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [organizationId, user.rows[0].id, parsed.data.role]);
      return user.rows[0];
    });
    await writeAuditEvent({ organizationId, actorId: actor.id, entityType: 'user', entityId: created.id, action: 'organization_user_created', metadata: { role: parsed.data.role }, ipAddress: clientIp(request) });
    return response.status(201).json({ user: created, role: parsed.data.role });
  } catch (error) {
    return response.status(409).json({ error: 'That username/email exists, or this customer already belongs to another organization.' });
  }
});

app.put('/api/projects/:projectId/access/:userId', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const projectId = routeParam(request.params.projectId);
  const userId = routeParam(request.params.userId);
  const project = await query<{ organization_id: string }>('SELECT organization_id FROM projects WHERE id = $1 AND deleted_at IS NULL', [projectId]);
  if (!project.rowCount) return response.status(404).json({ error: 'Project not found.' });
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, project.rows[0].organization_id);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  const parsed = projectAccessSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide valid access permissions.' });
  const membership = await query('SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2 AND is_active = true', [project.rows[0].organization_id, userId]);
  if (!membership.rowCount) return response.status(400).json({ error: 'The user must be an active member of this organization.' });

  const saved = await query(
    `INSERT INTO project_access (project_id, user_id, can_view, can_report, can_comment, can_manage)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, user_id) DO UPDATE SET can_view = EXCLUDED.can_view, can_report = EXCLUDED.can_report, can_comment = EXCLUDED.can_comment, can_manage = EXCLUDED.can_manage
     RETURNING *`,
    [projectId, userId, parsed.data.canView, parsed.data.canReport, parsed.data.canComment, parsed.data.canManage],
  );
  await writeAuditEvent({ organizationId: project.rows[0].organization_id, actorId: actor.id, entityType: 'project_access', entityId: saved.rows[0].id, action: 'project_access_updated', metadata: { projectId, userId, ...parsed.data }, ipAddress: clientIp(request) });
  response.json(saved.rows[0]);
});

app.get('/api/organizations/:organizationId/reports', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (!role) return response.status(403).json({ error: 'You do not have access to this organization.' });

  const status = request.query.status ? String(request.query.status) : null;
  const result = await query(
    `SELECT r.id, r.sequence_number AS "sequenceNumber", r.title, r.status, r.priority, r.updated_at AS "updatedAt", r.due_at AS "dueAt",
            p.id AS "projectId", p.name AS "projectName", u.display_name AS "reporterName", a.display_name AS "assigneeName",
            COALESCE(array_remove(array_agg(l.name), NULL), '{}') AS labels
     FROM reports r
     JOIN projects p ON p.id = r.project_id
     JOIN users u ON u.id = r.reporter_id
     LEFT JOIN users a ON a.id = r.assignee_id
     LEFT JOIN report_labels rl ON rl.report_id = r.id
     LEFT JOIN labels l ON l.id = rl.label_id
     WHERE r.organization_id = $1 AND r.deleted_at IS NULL
       AND ($2::bugflow_status IS NULL OR r.status = $2::bugflow_status)
       AND ($3::boolean = true OR EXISTS (SELECT 1 FROM project_access pa WHERE pa.project_id = r.project_id AND pa.user_id = $4 AND pa.can_view = true))
     GROUP BY r.id, p.id, u.id, a.id
     ORDER BY r.updated_at DESC`,
    [organizationId, status, role === 'admin' || actor.isPlatformAdmin, actor.id],
  );
  response.json({ reports: result.rows });
});

app.post('/api/reports', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const parsed = reportSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide a title, description, project, and valid report details.' });
  const access = await checkProjectAccess(actor, parsed.data.projectId, 'report');
  if (!access.allowed || !access.organizationId) return response.status(403).json({ error: 'You do not have permission to report bugs for this project.' });

  const report = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [access.organizationId]);
    const sequence = await client.query<{ next_number: number }>('SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_number FROM reports WHERE organization_id = $1', [access.organizationId]);
    const created = await client.query(
      `INSERT INTO reports (organization_id, project_id, sequence_number, title, description, reproduction_steps, expected_result, actual_result, browser_device, application_version, priority, reporter_id, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [access.organizationId, parsed.data.projectId, sequence.rows[0].next_number, parsed.data.title, parsed.data.description, parsed.data.reproductionSteps ?? null, parsed.data.expectedResult ?? null, parsed.data.actualResult ?? null, parsed.data.browserDevice ?? null, parsed.data.applicationVersion ?? null, parsed.data.priority, actor.id, parsed.data.dueAt ?? null],
    );
    return created.rows[0];
  });
  await writeAuditEvent({ organizationId: access.organizationId, actorId: actor.id, entityType: 'report', entityId: report.id, action: 'report_created', metadata: { sequenceNumber: report.sequence_number }, ipAddress: clientIp(request) });
  response.status(201).json(report);
});

app.post('/api/reports/:reportId/comments', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const parsed = commentSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'A comment is required.' });
  const access = await reportAccess(actor, reportId, parsed.data.visibility === 'internal' ? 'manage' : 'comment');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have permission to comment on this report.' });
  if (parsed.data.visibility === 'internal') {
    const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, access.report.organization_id);
    if (role === 'customer') return response.status(403).json({ error: 'Customers cannot create internal comments.' });
  }

  const result = await query('INSERT INTO report_comments (report_id, author_id, body, visibility) VALUES ($1, $2, $3, $4) RETURNING *', [reportId, actor.id, parsed.data.body, parsed.data.visibility]);
  await writeAuditEvent({ organizationId: access.report.organization_id, actorId: actor.id, entityType: 'report_comment', entityId: result.rows[0].id, action: parsed.data.visibility === 'internal' ? 'internal_comment_created' : 'customer_comment_created', metadata: { reportId }, ipAddress: clientIp(request) });
  response.status(201).json(result.rows[0]);
});

app.delete('/api/reports/:reportId', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const access = await reportAccess(actor, reportId, 'view');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have access to this report.' });
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, access.report.organization_id);
  if (access.report.reporter_id !== actor.id && role !== 'admin') return response.status(403).json({ error: 'Only the reporter or an administrator can delete this report.' });
  await query('UPDATE reports SET deleted_at = now(), deleted_by = $1 WHERE id = $2', [actor.id, reportId]);
  await writeAuditEvent({ organizationId: access.report.organization_id, actorId: actor.id, entityType: 'report', entityId: reportId, action: 'report_soft_deleted', ipAddress: clientIp(request) });
  response.status(204).end();
});

app.post('/api/reports/:reportId/restore', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const report = await query<{ organization_id: string }>('SELECT organization_id FROM reports WHERE id = $1', [reportId]);
  if (!report.rowCount) return response.status(404).json({ error: 'Report not found.' });
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, report.rows[0].organization_id);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  const restored = await query('UPDATE reports SET deleted_at = NULL, deleted_by = NULL, restored_at = now(), restored_by = $1 WHERE id = $2 RETURNING *', [actor.id, reportId]);
  await writeAuditEvent({ organizationId: report.rows[0].organization_id, actorId: actor.id, entityType: 'report', entityId: reportId, action: 'report_restored', ipAddress: clientIp(request) });
  response.json(restored.rows[0]);
});

app.post('/api/reports/:reportId/attachments', upload.single('file'), async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  if (!request.file) return response.status(400).json({ error: 'Attach one file to upload.' });
  const access = await reportAccess(actor, reportId, 'comment');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have permission to attach files to this report.' });
  if (!storageIsConfigured()) return response.status(503).json({ error: 'Attachment storage is not configured.' });

  const key = attachmentKey(access.report.organization_id, request.file.originalname);
  try {
    await uploadAttachment({ key, body: request.file.buffer, contentType: request.file.mimetype || 'application/octet-stream', originalFilename: request.file.originalname });
    const result = await query(
      `INSERT INTO attachments (organization_id, report_id, storage_key, original_filename, content_type, byte_size, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [access.report.organization_id, reportId, key, request.file.originalname, request.file.mimetype || 'application/octet-stream', request.file.size, actor.id],
    );
    await writeAuditEvent({ organizationId: access.report.organization_id, actorId: actor.id, entityType: 'attachment', entityId: result.rows[0].id, action: 'attachment_uploaded', metadata: { reportId, filename: request.file.originalname }, ipAddress: clientIp(request) });
    return response.status(201).json(result.rows[0]);
  } catch (error) {
    return response.status(502).json({ error: 'Attachment upload failed. Try again.' });
  }
});

app.get('/api/attachments/:attachmentId/download', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const attachment = await query<{ report_id: string; storage_key: string }>('SELECT report_id, storage_key FROM attachments WHERE id = $1', [request.params.attachmentId]);
  if (!attachment.rowCount) return response.status(404).json({ error: 'Attachment not found.' });
  const access = await reportAccess(actor, attachment.rows[0].report_id, 'view');
  if (!access.allowed) return response.status(403).json({ error: 'You do not have access to this attachment.' });
  try {
    const url = await signedAttachmentUrl(attachment.rows[0].storage_key);
    return response.json({ url, expiresInSeconds: 300 });
  } catch (error) {
    return response.status(503).json({ error: 'Attachment storage is unavailable.' });
  }
});

app.patch('/api/reports/:reportId/status', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const parsed = z.object({ status: z.enum(['new', 'acknowledged', 'in_progress', 'resolved', 'closed']) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide a valid status.' });
  const access = await reportAccess(actor, reportId, 'manage');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have permission to change this report.' });
  const updated = await query('UPDATE reports SET status = $1 WHERE id = $2 RETURNING *', [parsed.data.status, reportId]);
  await writeAuditEvent({ organizationId: access.report.organization_id, actorId: actor.id, entityType: 'report', entityId: reportId, action: 'status_changed', metadata: { status: parsed.data.status }, ipAddress: clientIp(request) });
  response.json(updated.rows[0]);
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) return response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Files must be 25 MB or smaller.' : 'Unable to process the attachment.' });
  console.error(error);
  return response.status(500).json({ error: 'An unexpected server error occurred.' });
});

const clientDirectory = path.resolve(process.cwd(), 'dist');
const indexHtml = path.join(clientDirectory, 'index.html');
if (existsSync(indexHtml)) {
  app.use(express.static(clientDirectory, { index: false, maxAge: '1h' }));
  app.use((_request, response) => response.sendFile(indexHtml));
}

app.listen(port, '0.0.0.0', () => {
  console.log(`BugFlow server listening on port ${port}`);
});
