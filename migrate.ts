import 'dotenv/config';
import { Pool } from 'pg';
import { developerAclReviewSchemaSql, developerRoleSchemaSql, expansionSchemaSql, schemaSql } from './schema.js';

const migrations = [
  { version: '001_initial_schema', sql: schemaSql },
  { version: '002_productivity_backup_schema', sql: expansionSchemaSql },
  { version: '003_developer_role_schema', sql: developerRoleSchemaSql },
  { version: '004_developer_acl_review_schema', sql: developerAclReviewSchemaSql },
] as const;

async function migrate() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required to run database migrations.');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.PGSSLMODE === 'disable' ? undefined : { rejectUnauthorized: false },
  });

  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS citext;');
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());');
    await pool.query('SELECT pg_advisory_lock(74821695)');
    try {
      for (const migration of migrations) {
        const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [migration.version]);
        if (applied.rowCount) {
          console.log(`Migration ${migration.version} already applied.`);
          continue;
        }
        await pool.query('BEGIN');
        try {
          await pool.query(migration.sql);
          await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
          await pool.query('COMMIT');
          console.log(`Applied ${migration.version}.`);
        } catch (error) {
          await pool.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await pool.query('SELECT pg_advisory_unlock(74821695)');
    }
  } finally {
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
