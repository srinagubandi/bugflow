import { Pool, type PoolClient, type QueryResultRow } from 'pg';

const connectionString = process.env.DATABASE_URL;

export const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: process.env.PGSSLMODE === 'disable' ? undefined : { rejectUnauthorized: false },
      max: 10,
    })
  : null;

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured.');
  }
  return pool.query<T>(text, values);
}

export async function withTransaction<T>(operation: (client: PoolClient) => Promise<T>) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function writeAuditEvent(input: {
  organizationId?: string | null;
  actorId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}) {
  await query(
    `INSERT INTO audit_events (organization_id, actor_id, entity_type, entity_id, action, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      input.organizationId ?? null,
      input.actorId ?? null,
      input.entityType,
      input.entityId ?? null,
      input.action,
      JSON.stringify(input.metadata ?? {}),
      input.ipAddress ?? null,
    ],
  );
}
