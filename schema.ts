export const schemaSql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE bugflow_role AS ENUM ('platform_admin', 'admin', 'team_member', 'customer');
CREATE TYPE bugflow_status AS ENUM ('new', 'acknowledged', 'in_progress', 'resolved', 'closed');
CREATE TYPE bugflow_priority AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE bugflow_comment_visibility AS ENUM ('customer', 'internal');

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo_key TEXT,
  sender_name TEXT,
  reply_to_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username CITEXT NOT NULL UNIQUE,
  email CITEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_platform_admin BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role bugflow_role NOT NULL CHECK (role IN ('admin', 'team_member', 'customer')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_customer_membership
  ON memberships(user_id)
  WHERE role = 'customer' AND is_active = true;

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL DEFAULT '#8176ff',
  sender_name TEXT,
  reply_to_email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS project_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_view BOOLEAN NOT NULL DEFAULT true,
  can_report BOOLEAN NOT NULL DEFAULT true,
  can_comment BOOLEAN NOT NULL DEFAULT true,
  can_manage BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#8176ff',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  sequence_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reproduction_steps TEXT,
  expected_result TEXT,
  actual_result TEXT,
  browser_device TEXT,
  application_version TEXT,
  status bugflow_status NOT NULL DEFAULT 'new',
  priority bugflow_priority NOT NULL DEFAULT 'medium',
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  restored_at TIMESTAMPTZ,
  restored_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS reports_project_status_idx ON reports(project_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS reports_assignee_idx ON reports(assignee_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS reports_org_updated_idx ON reports(organization_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS report_labels (
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (report_id, label_id)
);

CREATE TABLE IF NOT EXISTS report_duplicates (
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  duplicate_of_report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, duplicate_of_report_id),
  CHECK (report_id <> duplicate_of_report_id)
);

CREATE TABLE IF NOT EXISTS report_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  visibility bugflow_comment_visibility NOT NULL DEFAULT 'customer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_id UUID REFERENCES reports(id) ON DELETE CASCADE,
  comment_id UUID REFERENCES report_comments(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((report_id IS NOT NULL)::int + (comment_id IS NOT NULL)::int = 1)
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_id UUID REFERENCES reports(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  email_sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_org_created_idx ON audit_events(organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION bugflow_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organizations_set_updated_at ON organizations;
CREATE TRIGGER organizations_set_updated_at BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION bugflow_set_updated_at();

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION bugflow_set_updated_at();

DROP TRIGGER IF EXISTS projects_set_updated_at ON projects;
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION bugflow_set_updated_at();

DROP TRIGGER IF EXISTS reports_set_updated_at ON reports;
CREATE TRIGGER reports_set_updated_at BEFORE UPDATE ON reports
FOR EACH ROW EXECUTE FUNCTION bugflow_set_updated_at();

DROP TRIGGER IF EXISTS report_comments_set_updated_at ON report_comments;
CREATE TRIGGER report_comments_set_updated_at BEFORE UPDATE ON report_comments
FOR EACH ROW EXECUTE FUNCTION bugflow_set_updated_at();
`;


export const expansionSchemaSql = `
CREATE TYPE backup_frequency AS ENUM ('manual', 'weekly', 'monthly');
CREATE TYPE backup_run_status AS ENUM ('queued', 'running', 'succeeded', 'failed');

CREATE TABLE IF NOT EXISTS platform_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  backup_frequency backup_frequency NOT NULL DEFAULT 'manual',
  backup_enabled BOOLEAN NOT NULL DEFAULT false,
  backup_day_of_week SMALLINT NOT NULL DEFAULT 0 CHECK (backup_day_of_week BETWEEN 0 AND 6),
  backup_day_of_month SMALLINT NOT NULL DEFAULT 1 CHECK (backup_day_of_month BETWEEN 1 AND 28),
  backup_hour_utc SMALLINT NOT NULL DEFAULT 3 CHECK (backup_hour_utc BETWEEN 0 AND 23),
  last_backup_requested_at TIMESTAMPTZ,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS backup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status backup_run_status NOT NULL DEFAULT 'queued',
  trigger backup_frequency NOT NULL DEFAULT 'manual',
  storage_key TEXT UNIQUE,
  byte_size BIGINT CHECK (byte_size >= 0),
  checksum TEXT,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backup_runs_created_idx ON backup_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS saved_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, owner_id, name)
);
CREATE INDEX IF NOT EXISTS saved_views_org_idx ON saved_views(organization_id, owner_id);

CREATE TABLE IF NOT EXISTS report_subscriptions (
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, user_id)
);

CREATE TABLE IF NOT EXISTS release_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version TEXT,
  published_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS release_notes_org_published_idx ON release_notes(organization_id, published_at DESC NULLS LAST);

DROP TRIGGER IF EXISTS platform_settings_set_updated_at ON platform_settings;
CREATE TRIGGER platform_settings_set_updated_at BEFORE UPDATE ON platform_settings
FOR EACH ROW EXECUTE FUNCTION bugflow_set_updated_at();
DROP TRIGGER IF EXISTS saved_views_set_updated_at ON saved_views;
CREATE TRIGGER saved_views_set_updated_at BEFORE UPDATE ON saved_views
FOR EACH ROW EXECUTE FUNCTION bugflow_set_updated_at();
DROP TRIGGER IF EXISTS release_notes_set_updated_at ON release_notes;
CREATE TRIGGER release_notes_set_updated_at BEFORE UPDATE ON release_notes
FOR EACH ROW EXECUTE FUNCTION bugflow_set_updated_at();
`;
