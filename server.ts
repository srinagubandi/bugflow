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

function requirePlatformAdmin(request: AppRequest, response: Response): CurrentUser | null {
  const user = requireUser(request, response);
  if (!user) return null;
  if (!user.isPlatformAdmin) {
    response.status(403).json({ error: 'Platform administrator access is required.' });
    return null;
  }
  return user;
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

/** Customer-visible updates always create an in-product notification; email is attempted only when configured. */
async function notifyReporterOfVisibleUpdate(input: { reportId: string; actorId: string; type: string; update: string }) {
  const context = await query<{ organization_id: string; sequence_number: number; title: string; reporter_id: string; email: string; organization_name: string; sender_name: string | null; reply_to_email: string | null }>(
    `SELECT r.organization_id, r.sequence_number, r.title, r.reporter_id, u.email, o.name AS organization_name, o.sender_name, o.reply_to_email
     FROM reports r JOIN users u ON u.id = r.reporter_id JOIN organizations o ON o.id = r.organization_id WHERE r.id = $1`,
    [input.reportId],
  );
  const item = context.rows[0];
  if (!item || item.reporter_id === input.actorId) return;
  const title = `Update on BF-${item.sequence_number}`;
  const notification = await query<{ id: string }>(
    `INSERT INTO notifications (organization_id, user_id, report_id, type, title, body)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [item.organization_id, item.reporter_id, input.reportId, input.type, title, input.update],
  );
  try {
    const appUrl = process.env.APP_URL || 'https://bugflow-app-production.up.railway.app';
    const delivery = await sendBugFlowEmail({
      to: item.email,
      subject: title,
      html: reportUpdateEmail({ organizationName: item.organization_name, reportId: `BF-${item.sequence_number}`, reportTitle: item.title, update: input.update, url: `${appUrl}/?report=${input.reportId}` }),
      fromName: item.sender_name ?? item.organization_name,
      replyTo: item.reply_to_email,
    });
    if (delivery.sent) await query('UPDATE notifications SET email_sent_at = now() WHERE id = $1', [notification.rows[0].id]);
  } catch (error) {
    console.error('Customer update email could not be delivered', error);
  }
}

const loginSchema = z.object({ identifier: z.string().min(1), password: z.string().min(8) });
const organizationSchema = z.object({ name: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]+$/), admin: z.object({ username: z.string().min(3).max(60), email: z.string().email(), displayName: z.string().min(2).max(120), password: z.string().min(12).max(200) }) });
const projectSchema = z.object({ name: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]+$/), description: z.string().max(500).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#8176ff') });
const organizationUserSchema = z.object({ username: z.string().min(3).max(60), email: z.string().email(), displayName: z.string().min(2).max(120), password: z.string().min(12).max(200), role: z.enum(['admin', 'team_member', 'customer']) });
const projectAccessSchema = z.object({ canView: z.boolean().default(true), canReport: z.boolean().default(true), canComment: z.boolean().default(true), canManage: z.boolean().default(false) });
const reportSchema = z.object({ projectId: z.string().uuid(), title: z.string().min(4).max(240), description: z.string().min(4).max(20000), reproductionSteps: z.string().max(20000).optional(), expectedResult: z.string().max(20000).optional(), actualResult: z.string().max(20000).optional(), browserDevice: z.string().max(500).optional(), applicationVersion: z.string().max(200).optional(), priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'), dueAt: z.string().datetime().optional() });
const commentSchema = z.object({ body: z.string().min(1).max(20000), visibility: z.enum(['customer', 'internal']).default('customer') });
const passwordResetRequestSchema = z.object({ email: z.string().email() });
const passwordResetConfirmSchema = z.object({ token: z.string().min(20), password: z.string().min(12).max(200) });

/** These schemas keep every property-rail update explicit and auditable. */
const reportUpdateSchema = z.object({
  title: z.string().min(4).max(240).optional(),
  description: z.string().min(4).max(20000).optional(),
  reproductionSteps: z.string().max(20000).nullable().optional(),
  expectedResult: z.string().max(20000).nullable().optional(),
  actualResult: z.string().max(20000).nullable().optional(),
  browserDevice: z.string().max(500).nullable().optional(),
  applicationVersion: z.string().max(200).nullable().optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  dueAt: z.string().datetime().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one report field.');
const assigneeSchema = z.object({ assigneeId: z.string().uuid().nullable() });
const labelSchema = z.object({ name: z.string().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6750A4') });
const reportLabelSchema = z.object({ labelId: z.string().uuid() });
const duplicateSchema = z.object({ duplicateOfId: z.string().uuid() });
const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['manual', 'weekly', 'monthly']),
  dayOfWeek: z.number().int().min(0).max(6).default(0),
  dayOfMonth: z.number().int().min(1).max(28).default(1),
  hourUtc: z.number().int().min(0).max(23).default(3),
});
const savedViewSchema = z.object({ name: z.string().min(1).max(80), filters: z.record(z.string(), z.unknown()).default({}), isShared: z.boolean().default(false) });
const bulkReportSchema = z.object({ reportIds: z.array(z.string().uuid()).min(1).max(100), status: z.enum(['new', 'acknowledged', 'in_progress', 'resolved', 'closed']).optional(), assigneeId: z.string().uuid().nullable().optional() }).refine((value) => value.status !== undefined || value.assigneeId !== undefined, 'Choose a bulk update.');
const releaseNoteSchema = z.object({ projectId: z.string().uuid().nullable().optional(), title: z.string().min(3).max(180), body: z.string().min(3).max(20000), version: z.string().max(80).nullable().optional(), publish: z.boolean().default(false) });

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

app.post('/api/auth/password-reset/request', async (request: Request, response: Response) => {
  const parsed = passwordResetRequestSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide a valid email address.' });

  try {
    const account = await query<{ id: string; email: string; display_name: string }>(
      'SELECT id, email, display_name FROM users WHERE email = $1 AND is_active = true AND deleted_at IS NULL',
      [parsed.data.email],
    );
    if (!account.rowCount) return response.status(202).json({ accepted: true });

    const token = randomBytes(32).toString('base64url');
    await query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval \'1 hour\')', [account.rows[0].id, hashToken(token)]);
    const appUrl = process.env.APP_URL || `${request.protocol}://${request.get('host')}`;
    const resetUrl = `${appUrl}/?reset=${encodeURIComponent(token)}`;
    const delivery = await sendBugFlowEmail({
      to: account.rows[0].email,
      subject: 'Reset your BugFlow password',
      html: `<div style="font-family:Inter,Arial,sans-serif;color:#24242a;line-height:1.5"><p style="color:#6b61dd;font-weight:700">BugFlow</p><h2>Reset your password</h2><p>Hello ${account.rows[0].display_name}, use the secure link below within one hour.</p><p><a href="${resetUrl}" style="display:inline-block;background:#6257dc;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reset password</a></p><p style="color:#666;font-size:12px">If you did not request this change, you can ignore this email.</p></div>`,
    });
    if (!delivery.sent) {
      await query('DELETE FROM password_reset_tokens WHERE token_hash = $1', [hashToken(token)]);
      return response.status(503).json({ error: 'Password reset email delivery is not configured. Contact your administrator.' });
    }
    await writeAuditEvent({ actorId: account.rows[0].id, entityType: 'authentication', action: 'password_reset_requested', ipAddress: clientIp(request) });
    return response.status(202).json({ accepted: true });
  } catch (error) {
    return response.status(503).json({ error: 'Password reset email delivery is not configured. Contact your administrator.' });
  }
});

app.post('/api/auth/password-reset/confirm', async (request: Request, response: Response) => {
  const parsed = passwordResetConfirmSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide a valid reset token and a password of at least 12 characters.' });
  try {
    const reset = await query<{ id: string; user_id: string }>('SELECT id, user_id FROM password_reset_tokens WHERE token_hash = $1 AND expires_at > now() AND used_at IS NULL', [hashToken(parsed.data.token)]);
    if (!reset.rowCount) return response.status(400).json({ error: 'This password-reset link is invalid or has expired.' });
    await withTransaction(async (client) => {
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(parsed.data.password), reset.rows[0].user_id]);
      await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [reset.rows[0].id]);
      await client.query('DELETE FROM sessions WHERE user_id = $1', [reset.rows[0].user_id]);
    });
    await writeAuditEvent({ actorId: reset.rows[0].user_id, entityType: 'authentication', action: 'password_reset_completed', ipAddress: clientIp(request) });
    return response.status(204).end();
  } catch (error) {
    return response.status(503).json({ error: 'Password reset is temporarily unavailable.' });
  }
});

app.get('/api/auth/session', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;

  const organizations = await query<{ id: string; name: string; slug: string; role: string }>(
    actor.isPlatformAdmin
      ? `SELECT o.id, o.name, o.slug, 'platform_admin' AS role FROM organizations o WHERE o.deleted_at IS NULL ORDER BY o.name`
      : `SELECT o.id, o.name, o.slug, m.role
         FROM memberships m JOIN organizations o ON o.id = m.organization_id
         WHERE m.user_id = $1 AND m.is_active = true AND o.deleted_at IS NULL
         ORDER BY o.name`,
    actor.isPlatformAdmin ? [] : [actor.id],
  );

  response.json({ user: actor, organizations: organizations.rows });
});

app.get('/api/organizations/:organizationId/projects', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (!role) return response.status(403).json({ error: 'You do not have access to this organization.' });

  const result = await query(
    `SELECT p.id, p.name, p.slug, p.description, p.color, p.created_at AS "createdAt",
            COUNT(r.id) FILTER (WHERE r.deleted_at IS NULL AND r.status NOT IN ('resolved', 'closed'))::int AS "openReportCount"
     FROM projects p
     LEFT JOIN reports r ON r.project_id = p.id
     WHERE p.organization_id = $1 AND p.is_active = true AND p.deleted_at IS NULL
       AND ($2::boolean = true OR EXISTS (SELECT 1 FROM project_access pa WHERE pa.project_id = p.id AND pa.user_id = $3 AND pa.can_view = true))
     GROUP BY p.id
     ORDER BY p.name`,
    [organizationId, role === 'admin' || actor.isPlatformAdmin, actor.id],
  );
  response.json({ projects: result.rows });
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
  const priority = request.query.priority ? String(request.query.priority) : null;
  const projectId = request.query.projectId ? String(request.query.projectId) : null;
  const assigneeId = request.query.assigneeId ? String(request.query.assigneeId) : null;
  const search = request.query.q ? String(request.query.q).trim().slice(0, 200) : null;
  const due = request.query.due === 'overdue' ? 'overdue' : request.query.due === 'none' ? 'none' : null;
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
       AND ($3::bugflow_priority IS NULL OR r.priority = $3::bugflow_priority)
       AND ($4::uuid IS NULL OR r.project_id = $4::uuid)
       AND ($5::uuid IS NULL OR r.assignee_id = $5::uuid)
       AND ($6::text IS NULL OR r.title ILIKE '%' || $6 || '%' OR r.description ILIKE '%' || $6 || '%')
       AND ($7::text IS NULL OR ($7 = 'overdue' AND r.due_at < now() AND r.status NOT IN ('resolved', 'closed')) OR ($7 = 'none' AND r.due_at IS NULL))
       AND ($8::boolean = true OR EXISTS (SELECT 1 FROM project_access pa WHERE pa.project_id = r.project_id AND pa.user_id = $9 AND pa.can_view = true))
     GROUP BY r.id, p.id, u.id, a.id
     ORDER BY CASE WHEN r.due_at IS NOT NULL AND r.status NOT IN ('resolved', 'closed') THEN 0 ELSE 1 END, r.due_at ASC NULLS LAST, r.updated_at DESC`,
    [organizationId, status, priority, projectId, assigneeId, search, due, role === 'admin' || actor.isPlatformAdmin, actor.id],
  );
  response.json({ reports: result.rows });
});

/** Detail payload intentionally separates customer-visible activity from internal activity. */
app.get('/api/reports/:reportId', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const access = await reportAccess(actor, reportId, 'view');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have access to this report.' });
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, access.report.organization_id);
  const report = await query(
    `SELECT r.*, r.sequence_number AS "sequenceNumber", p.name AS "projectName", p.slug AS "projectSlug", u.display_name AS "reporterName", a.display_name AS "assigneeName"
     FROM reports r JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = r.reporter_id
     LEFT JOIN users a ON a.id = r.assignee_id WHERE r.id = $1`, [reportId],
  );
  const comments = await query(
    `SELECT c.id, c.body, c.visibility, c.created_at AS "createdAt", c.updated_at AS "updatedAt", u.display_name AS "authorName"
     FROM report_comments c JOIN users u ON u.id = c.author_id
     WHERE c.report_id = $1 AND c.deleted_at IS NULL AND ($2::boolean = true OR c.visibility = 'customer') ORDER BY c.created_at ASC`,
    [reportId, role !== 'customer'],
  );
  const attachments = await query(
    `SELECT id, original_filename AS "originalFilename", content_type AS "contentType", byte_size AS "byteSize", created_at AS "createdAt"
     FROM attachments WHERE report_id = $1 ORDER BY created_at ASC`, [reportId],
  );
  const labels = await query(`SELECT l.id, l.name, l.color FROM report_labels rl JOIN labels l ON l.id = rl.label_id WHERE rl.report_id = $1 ORDER BY l.name`, [reportId]);
  const duplicates = await query(
    `SELECT r.id, r.sequence_number AS "sequenceNumber", r.title, r.status
     FROM report_duplicates rd JOIN reports r ON r.id = rd.duplicate_of_report_id WHERE rd.report_id = $1 AND r.deleted_at IS NULL`, [reportId],
  );
  response.json({ report: report.rows[0], comments: comments.rows, attachments: attachments.rows, labels: labels.rows, duplicates: duplicates.rows });
});

app.patch('/api/reports/:reportId', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const parsed = reportUpdateSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide valid report fields.' });
  const access = await reportAccess(actor, reportId, 'view');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have access to this report.' });
  const manage = await checkProjectAccess(actor, access.report.project_id, 'manage');
  if (access.report.reporter_id !== actor.id && !manage.allowed) return response.status(403).json({ error: 'Only the reporter or a project manager can edit this report.' });
  const columns: Array<[string, unknown]> = [];
  const values = parsed.data;
  if (values.title !== undefined) columns.push(['title', values.title]);
  if (values.description !== undefined) columns.push(['description', values.description]);
  if (values.reproductionSteps !== undefined) columns.push(['reproduction_steps', values.reproductionSteps]);
  if (values.expectedResult !== undefined) columns.push(['expected_result', values.expectedResult]);
  if (values.actualResult !== undefined) columns.push(['actual_result', values.actualResult]);
  if (values.browserDevice !== undefined) columns.push(['browser_device', values.browserDevice]);
  if (values.applicationVersion !== undefined) columns.push(['application_version', values.applicationVersion]);
  if (values.priority !== undefined) columns.push(['priority', values.priority]);
  if (values.dueAt !== undefined) columns.push(['due_at', values.dueAt]);
  const assignments = columns.map(([column], index) => `${column} = $${index + 1}`).join(', ');
  const updated = await query(`UPDATE reports SET ${assignments} WHERE id = $${columns.length + 1} RETURNING *`, [...columns.map(([, value]) => value), reportId]);
  await writeAuditEvent({ organizationId: access.report.organization_id, actorId: actor.id, entityType: 'report', entityId: reportId, action: 'report_updated', metadata: { fields: columns.map(([column]) => column) }, ipAddress: clientIp(request) });
  response.json(updated.rows[0]);
});

app.patch('/api/reports/:reportId/assignee', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const parsed = assigneeSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide a valid assignee.' });
  const access = await reportAccess(actor, reportId, 'manage');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have permission to assign this report.' });
  if (parsed.data.assigneeId) {
    const assignee = await query(`SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2 AND is_active = true AND role IN ('admin', 'team_member')`, [access.report.organization_id, parsed.data.assigneeId]);
    if (!assignee.rowCount) return response.status(400).json({ error: 'The assignee must be an active administrator or team member in this organization.' });
  }
  const updated = await query('UPDATE reports SET assignee_id = $1 WHERE id = $2 RETURNING *', [parsed.data.assigneeId, reportId]);
  await writeAuditEvent({ organizationId: access.report.organization_id, actorId: actor.id, entityType: 'report', entityId: reportId, action: 'assignee_changed', metadata: { assigneeId: parsed.data.assigneeId }, ipAddress: clientIp(request) });
  if (parsed.data.assigneeId && parsed.data.assigneeId !== actor.id) {
    await query(`INSERT INTO notifications (organization_id, user_id, report_id, type, title, body) VALUES ($1, $2, $3, 'assignment', 'A report was assigned to you', 'Open the report to review its priority and due date.')`, [access.report.organization_id, parsed.data.assigneeId, reportId]);
  }
  response.json(updated.rows[0]);
});

app.get('/api/organizations/:organizationId/labels', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (!role) return response.status(403).json({ error: 'You do not have access to this organization.' });
  const labels = await query('SELECT id, name, color, created_at AS "createdAt" FROM labels WHERE organization_id = $1 ORDER BY name', [organizationId]);
  response.json({ labels: labels.rows });
});

app.post('/api/organizations/:organizationId/labels', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  const parsed = labelSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide a valid label name and color.' });
  try {
    const label = await query('INSERT INTO labels (organization_id, name, color) VALUES ($1, $2, $3) RETURNING *', [organizationId, parsed.data.name, parsed.data.color]);
    await writeAuditEvent({ organizationId, actorId: actor.id, entityType: 'label', entityId: label.rows[0].id, action: 'label_created', metadata: parsed.data, ipAddress: clientIp(request) });
    response.status(201).json(label.rows[0]);
  } catch { response.status(409).json({ error: 'A label with that name already exists.' }); }
});

app.patch('/api/organizations/:organizationId/labels/:labelId', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  const parsed = labelSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide a valid label name and color.' });
  const updated = await query('UPDATE labels SET name = $1, color = $2 WHERE id = $3 AND organization_id = $4 RETURNING *', [parsed.data.name, parsed.data.color, routeParam(request.params.labelId), organizationId]);
  if (!updated.rowCount) return response.status(404).json({ error: 'Label not found.' });
  response.json(updated.rows[0]);
});

app.delete('/api/organizations/:organizationId/labels/:labelId', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  const removed = await query('DELETE FROM labels WHERE id = $1 AND organization_id = $2 RETURNING id', [routeParam(request.params.labelId), organizationId]);
  if (!removed.rowCount) return response.status(404).json({ error: 'Label not found.' });
  response.status(204).end();
});

app.post('/api/reports/:reportId/labels', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const parsed = reportLabelSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide a valid label.' });
  const access = await reportAccess(actor, reportId, 'manage');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have permission to label this report.' });
  const label = await query('SELECT id FROM labels WHERE id = $1 AND organization_id = $2', [parsed.data.labelId, access.report.organization_id]);
  if (!label.rowCount) return response.status(400).json({ error: 'The label does not belong to this organization.' });
  await query('INSERT INTO report_labels (report_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [reportId, parsed.data.labelId]);
  await writeAuditEvent({ organizationId: access.report.organization_id, actorId: actor.id, entityType: 'report_label', entityId: reportId, action: 'report_labeled', metadata: { labelId: parsed.data.labelId }, ipAddress: clientIp(request) });
  response.status(201).json({ reportId, labelId: parsed.data.labelId });
});

app.delete('/api/reports/:reportId/labels/:labelId', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const access = await reportAccess(actor, reportId, 'manage');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have permission to edit labels on this report.' });
  await query('DELETE FROM report_labels WHERE report_id = $1 AND label_id = $2', [reportId, routeParam(request.params.labelId)]);
  response.status(204).end();
});

app.post('/api/reports/:reportId/duplicates', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const parsed = duplicateSchema.safeParse(request.body);
  if (!parsed.success || parsed.data.duplicateOfId === reportId) return response.status(400).json({ error: 'Provide a different valid duplicate report.' });
  const access = await reportAccess(actor, reportId, 'manage');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have permission to link duplicates.' });
  const duplicate = await query('SELECT id FROM reports WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [parsed.data.duplicateOfId, access.report.organization_id]);
  if (!duplicate.rowCount) return response.status(400).json({ error: 'Duplicate reports must belong to the same organization.' });
  await query('INSERT INTO report_duplicates (report_id, duplicate_of_report_id, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [reportId, parsed.data.duplicateOfId, actor.id]);
  await writeAuditEvent({ organizationId: access.report.organization_id, actorId: actor.id, entityType: 'report_duplicate', entityId: reportId, action: 'duplicate_linked', metadata: { duplicateOfId: parsed.data.duplicateOfId }, ipAddress: clientIp(request) });
  response.status(201).json({ reportId, duplicateOfId: parsed.data.duplicateOfId });
});

app.delete('/api/reports/:reportId/duplicates/:duplicateOfId', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const access = await reportAccess(actor, reportId, 'manage');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have permission to unlink duplicates.' });
  await query('DELETE FROM report_duplicates WHERE report_id = $1 AND duplicate_of_report_id = $2', [reportId, routeParam(request.params.duplicateOfId)]);
  response.status(204).end();
});

app.get('/api/organizations/:organizationId/users', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  const users = await query(`SELECT u.id, u.username, u.email, u.display_name AS "displayName", u.is_active AS "isActive", m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 ORDER BY u.display_name`, [organizationId]);
  response.json({ users: users.rows });
});

async function changeUserState(request: AppRequest, response: Response, active: boolean) {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const userId = routeParam(request.params.userId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  if (!active && userId === actor.id) return response.status(400).json({ error: 'Administrators cannot deactivate their own account.' });
  const membership = await query('SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2', [organizationId, userId]);
  if (!membership.rowCount) return response.status(404).json({ error: 'User is not a member of this organization.' });
  await withTransaction(async (client) => {
    await client.query('UPDATE users SET is_active = $1 WHERE id = $2', [active, userId]);
    await client.query('UPDATE memberships SET is_active = $1 WHERE organization_id = $2 AND user_id = $3', [active, organizationId, userId]);
    if (!active) await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  });
  await writeAuditEvent({ organizationId, actorId: actor.id, entityType: 'user', entityId: userId, action: active ? 'user_activated' : 'user_deactivated', ipAddress: clientIp(request) });
  response.json({ userId, isActive: active });
}
app.post('/api/organizations/:organizationId/users/:userId/deactivate', (request: AppRequest, response) => changeUserState(request, response, false));
app.post('/api/organizations/:organizationId/users/:userId/activate', (request: AppRequest, response) => changeUserState(request, response, true));

app.get('/api/organizations/:organizationId/audit', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  const events = await query(`SELECT e.id, e.action, e.entity_type AS "entityType", e.entity_id AS "entityId", e.metadata, e.created_at AS "createdAt", u.display_name AS "actorName" FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.organization_id = $1 ORDER BY e.created_at DESC LIMIT 200`, [organizationId]);
  response.json({ events: events.rows });
});

app.get('/api/notifications', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const notifications = await query(
    `SELECT n.id, n.type, n.title, n.body, n.read_at AS "readAt", n.created_at AS "createdAt", r.sequence_number AS "sequenceNumber", r.title AS "reportTitle"
     FROM notifications n LEFT JOIN reports r ON r.id = n.report_id WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 100`,
    [actor.id],
  );
  response.json({ notifications: notifications.rows });
});

app.patch('/api/notifications/:notificationId/read', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const notification = await query('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id, read_at AS "readAt"', [routeParam(request.params.notificationId), actor.id]);
  if (!notification.rowCount) return response.status(404).json({ error: 'Notification not found.' });
  response.json(notification.rows[0]);
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
  if (parsed.data.visibility === 'customer') await notifyReporterOfVisibleUpdate({ reportId, actorId: actor.id, type: 'customer_comment', update: 'A new customer-visible comment was added.' });
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
  await notifyReporterOfVisibleUpdate({ reportId, actorId: actor.id, type: 'status_changed', update: `Status changed to ${parsed.data.status.replace('_', ' ')}.` });
  response.json(updated.rows[0]);
});

app.get('/api/platform/settings', async (request: AppRequest, response) => {
  const actor = requirePlatformAdmin(request, response);
  if (!actor) return;
  const settings = await query(`SELECT backup_frequency AS "backupFrequency", backup_enabled AS "backupEnabled", backup_day_of_week AS "backupDayOfWeek", backup_day_of_month AS "backupDayOfMonth", backup_hour_utc AS "backupHourUtc", last_backup_requested_at AS "lastBackupRequestedAt", updated_at AS "updatedAt" FROM platform_settings WHERE id = true`);
  response.json({ settings: settings.rows[0] ?? null, email: { configured: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL), from: process.env.RESEND_FROM_EMAIL ?? null, appUrl: process.env.APP_URL ?? null } });
});

app.patch('/api/platform/settings/backups', async (request: AppRequest, response) => {
  const actor = requirePlatformAdmin(request, response);
  if (!actor) return;
  const parsed = backupSettingsSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide a valid backup frequency and UTC schedule.' });
  const settings = await query(
    `UPDATE platform_settings SET backup_frequency = $1, backup_enabled = $2, backup_day_of_week = $3, backup_day_of_month = $4, backup_hour_utc = $5, updated_by = $6
     WHERE id = true RETURNING backup_frequency AS "backupFrequency", backup_enabled AS "backupEnabled", backup_day_of_week AS "backupDayOfWeek", backup_day_of_month AS "backupDayOfMonth", backup_hour_utc AS "backupHourUtc", updated_at AS "updatedAt"`,
    [parsed.data.frequency, parsed.data.enabled, parsed.data.dayOfWeek, parsed.data.dayOfMonth, parsed.data.hourUtc, actor.id],
  );
  await writeAuditEvent({ actorId: actor.id, entityType: 'backup_policy', action: 'backup_policy_updated', metadata: parsed.data, ipAddress: clientIp(request) });
  response.json({ settings: settings.rows[0] });
});

app.get('/api/platform/backups', async (request: AppRequest, response) => {
  const actor = requirePlatformAdmin(request, response);
  if (!actor) return;
  const runs = await query(`SELECT id, status, trigger, storage_key AS "storageKey", byte_size AS "byteSize", checksum, requested_by AS "requestedBy", started_at AS "startedAt", completed_at AS "completedAt", error_message AS "errorMessage", created_at AS "createdAt" FROM backup_runs ORDER BY created_at DESC LIMIT 50`);
  response.json({ runs: runs.rows });
});

app.post('/api/platform/backups', async (request: AppRequest, response) => {
  const actor = requirePlatformAdmin(request, response);
  if (!actor) return;
  if (!storageIsConfigured()) return response.status(503).json({ error: 'Private Railway object storage is required before backups can run.' });
  const active = await query(`SELECT id FROM backup_runs WHERE status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`);
  if (active.rowCount) return response.status(409).json({ error: 'A backup is already queued or running.' });
  const run = await query(`INSERT INTO backup_runs (status, trigger, requested_by) VALUES ('queued', 'manual', $1) RETURNING id, status, trigger, created_at AS "createdAt"`, [actor.id]);
  await query('UPDATE platform_settings SET last_backup_requested_at = now(), updated_by = $1 WHERE id = true', [actor.id]);
  await writeAuditEvent({ actorId: actor.id, entityType: 'backup_run', entityId: run.rows[0].id, action: 'backup_requested', metadata: { trigger: 'manual' }, ipAddress: clientIp(request) });
  response.status(202).json({ run: run.rows[0], message: 'Backup queued. The Railway backup job will process it on its next run.' });
});

app.get('/api/organizations/:organizationId/views', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (!role) return response.status(403).json({ error: 'You do not have access to this organization.' });
  const views = await query(`SELECT id, name, filters, is_shared AS "isShared", owner_id AS "ownerId", created_at AS "createdAt", updated_at AS "updatedAt" FROM saved_views WHERE organization_id = $1 AND (owner_id = $2 OR is_shared = true OR $3::boolean = true) ORDER BY is_shared DESC, name`, [organizationId, actor.id, role === 'admin' || actor.isPlatformAdmin]);
  response.json({ views: views.rows });
});

app.post('/api/organizations/:organizationId/views', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (!role) return response.status(403).json({ error: 'You do not have access to this organization.' });
  const parsed = savedViewSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide a name and valid filters.' });
  if (parsed.data.isShared && role !== 'admin' && !actor.isPlatformAdmin) return response.status(403).json({ error: 'Only administrators can create shared views.' });
  try {
    const created = await query(`INSERT INTO saved_views (organization_id, owner_id, name, filters, is_shared) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id, name, filters, is_shared AS "isShared", owner_id AS "ownerId", created_at AS "createdAt"`, [organizationId, actor.id, parsed.data.name, JSON.stringify(parsed.data.filters), parsed.data.isShared]);
    response.status(201).json({ view: created.rows[0] });
  } catch { response.status(409).json({ error: 'You already have a view with that name.' }); }
});

app.delete('/api/organizations/:organizationId/views/:viewId', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (!role) return response.status(403).json({ error: 'You do not have access to this organization.' });
  const removed = await query(`DELETE FROM saved_views WHERE id = $1 AND organization_id = $2 AND (owner_id = $3 OR $4::boolean = true) RETURNING id`, [routeParam(request.params.viewId), organizationId, actor.id, role === 'admin' || actor.isPlatformAdmin]);
  if (!removed.rowCount) return response.status(404).json({ error: 'Saved view not found.' });
  response.status(204).end();
});

app.patch('/api/organizations/:organizationId/reports/bulk', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const parsed = bulkReportSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide one to one hundred reports and a bulk update.' });
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (!role) return response.status(403).json({ error: 'You do not have access to this organization.' });
  const reports = await query<{ id: string; project_id: string }>('SELECT id, project_id FROM reports WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL', [organizationId, parsed.data.reportIds]);
  if (reports.rowCount !== parsed.data.reportIds.length) return response.status(404).json({ error: 'One or more reports were not found.' });
  for (const report of reports.rows) {
    const access = await checkProjectAccess(actor, report.project_id, 'manage');
    if (!access.allowed) return response.status(403).json({ error: 'You do not have permission to bulk-update every selected report.' });
  }
  const hasAssignee = Object.prototype.hasOwnProperty.call(parsed.data, 'assigneeId');
  if (hasAssignee && parsed.data.assigneeId) {
    const member = await query(`SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2 AND is_active = true AND role IN ('admin', 'team_member')`, [organizationId, parsed.data.assigneeId]);
    if (!member.rowCount) return response.status(400).json({ error: 'The assignee must be an active administrator or team member.' });
  }
  const updated = await query(`UPDATE reports SET status = COALESCE($1::bugflow_status, status), assignee_id = CASE WHEN $2::boolean THEN $3::uuid ELSE assignee_id END WHERE id = ANY($4::uuid[]) RETURNING id, status, assignee_id AS "assigneeId"`, [parsed.data.status ?? null, hasAssignee, parsed.data.assigneeId ?? null, parsed.data.reportIds]);
  await writeAuditEvent({ organizationId, actorId: actor.id, entityType: 'report', action: 'reports_bulk_updated', metadata: { reportIds: parsed.data.reportIds, status: parsed.data.status, assigneeId: parsed.data.assigneeId }, ipAddress: clientIp(request) });
  response.json({ reports: updated.rows });
});

app.get('/api/reports/:reportId/subscription', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const access = await reportAccess(actor, routeParam(request.params.reportId), 'view');
  if (!access.allowed) return response.status(403).json({ error: 'You do not have access to this report.' });
  const subscription = await query('SELECT 1 FROM report_subscriptions WHERE report_id = $1 AND user_id = $2', [routeParam(request.params.reportId), actor.id]);
  response.json({ subscribed: Boolean(subscription.rowCount) });
});

app.post('/api/reports/:reportId/subscription', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const access = await reportAccess(actor, reportId, 'view');
  if (!access.allowed) return response.status(403).json({ error: 'You do not have access to this report.' });
  await query('INSERT INTO report_subscriptions (report_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [reportId, actor.id]);
  response.status(201).json({ subscribed: true });
});

app.delete('/api/reports/:reportId/subscription', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const access = await reportAccess(actor, reportId, 'view');
  if (!access.allowed) return response.status(403).json({ error: 'You do not have access to this report.' });
  await query('DELETE FROM report_subscriptions WHERE report_id = $1 AND user_id = $2', [reportId, actor.id]);
  response.status(204).end();
});

app.get('/api/reports/:reportId/duplicate-suggestions', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const reportId = routeParam(request.params.reportId);
  const access = await reportAccess(actor, reportId, 'view');
  if (!access.allowed || !access.report) return response.status(403).json({ error: 'You do not have access to this report.' });
  const matches = await query(`SELECT candidate.id, candidate.sequence_number AS "sequenceNumber", candidate.title, candidate.status, candidate.priority FROM reports source JOIN reports candidate ON candidate.organization_id = source.organization_id WHERE source.id = $1 AND candidate.id <> source.id AND candidate.deleted_at IS NULL AND (candidate.title ILIKE '%' || split_part(source.title, ' ', 1) || '%' OR source.title ILIKE '%' || split_part(candidate.title, ' ', 1) || '%') ORDER BY candidate.updated_at DESC LIMIT 8`, [reportId]);
  response.json({ suggestions: matches.rows });
});

app.get('/api/organizations/:organizationId/release-notes', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (!role) return response.status(403).json({ error: 'You do not have access to this organization.' });
  const notes = await query(`SELECT id, project_id AS "projectId", title, body, version, published_at AS "publishedAt", created_at AS "createdAt" FROM release_notes WHERE organization_id = $1 AND ($2::boolean = true OR published_at IS NOT NULL) ORDER BY published_at DESC NULLS LAST, created_at DESC`, [organizationId, role === 'admin' || actor.isPlatformAdmin]);
  response.json({ releaseNotes: notes.rows });
});

app.post('/api/organizations/:organizationId/release-notes', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  const parsed = releaseNoteSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Provide valid release-note content.' });
  if (parsed.data.projectId) {
    const project = await query('SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [parsed.data.projectId, organizationId]);
    if (!project.rowCount) return response.status(400).json({ error: 'The selected project does not belong to this organization.' });
  }
  const note = await query(`INSERT INTO release_notes (organization_id, project_id, title, body, version, published_at, created_by) VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() ELSE NULL END, $7) RETURNING id, project_id AS "projectId", title, body, version, published_at AS "publishedAt", created_at AS "createdAt"`, [organizationId, parsed.data.projectId ?? null, parsed.data.title, parsed.data.body, parsed.data.version ?? null, parsed.data.publish, actor.id]);
  await writeAuditEvent({ organizationId, actorId: actor.id, entityType: 'release_note', entityId: note.rows[0].id, action: parsed.data.publish ? 'release_note_published' : 'release_note_drafted', ipAddress: clientIp(request) });
  response.status(201).json({ releaseNote: note.rows[0] });
});

app.post('/api/organizations/:organizationId/release-notes/:noteId/publish', async (request: AppRequest, response) => {
  const actor = requireUser(request, response);
  if (!actor) return;
  const organizationId = routeParam(request.params.organizationId);
  const role = actor.isPlatformAdmin ? 'admin' : await organizationRole(actor.id, organizationId);
  if (role !== 'admin') return response.status(403).json({ error: 'Organization administrator access is required.' });
  const note = await query(`UPDATE release_notes SET published_at = now() WHERE id = $1 AND organization_id = $2 RETURNING id, published_at AS "publishedAt"`, [routeParam(request.params.noteId), organizationId]);
  if (!note.rowCount) return response.status(404).json({ error: 'Release note not found.' });
  response.json({ releaseNote: note.rows[0] });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) return response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Files must be 25 MB or smaller.' : 'Unable to process the attachment.' });
  console.error(error);
  return response.status(500).json({ error: 'An unexpected server error occurred.' });
});

const clientDirectory = path.resolve(process.cwd(), 'dist');
const indexHtml = path.join(clientDirectory, 'index.html');

// API misses must stay JSON responses; otherwise the SPA fallback can disguise a missing workflow as HTTP 200.
app.use('/api', (_request, response) => response.status(404).json({ error: 'API route not found.' }));
if (existsSync(indexHtml)) {
  app.use(express.static(clientDirectory, { index: false, maxAge: '1h' }));
  app.use((_request, response) => response.sendFile(indexHtml));
}

app.listen(port, '0.0.0.0', () => {
  console.log(`BugFlow server listening on port ${port}`);
});
