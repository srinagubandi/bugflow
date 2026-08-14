import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { backupStorageIsConfigured, backupStorageKey, uploadBackupArchive } from './backup-storage.js';

type BackupFrequency = 'manual' | 'weekly' | 'monthly';
type Settings = { backup_frequency: BackupFrequency; backup_enabled: boolean; backup_day_of_week: number; backup_day_of_month: number; backup_hour_utc: number };
type Run = { id: string; trigger: BackupFrequency };

function isDue(settings: Settings, now: Date) {
  if (!settings.backup_enabled || settings.backup_frequency === 'manual') return false;
  if (now.getUTCHours() !== settings.backup_hour_utc) return false;
  if (settings.backup_frequency === 'weekly') return now.getUTCDay() === settings.backup_day_of_week;
  return now.getUTCDate() === settings.backup_day_of_month;
}

function runPgDump(databaseUrl: string, target: string) {
  return new Promise<void>((resolve, reject) => {
    const source = new URL(databaseUrl);
    const username = decodeURIComponent(source.username);
    const password = decodeURIComponent(source.password);
    const database = source.pathname.replace(/^\//, '');
    const sslMode = source.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? 'disable';
    const command = spawn(
      'pg_dump',
      [
        '--host', source.hostname,
        '--port', source.port || '5432',
        '--username', username,
        '--dbname', database,
        '--format=custom',
        '--file', target,
        '--no-owner',
        '--no-acl',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PGPASSWORD: password, PGSSLMODE: sslMode },
      },
    );
    let stderr = '';
    const timeout = setTimeout(() => command.kill('SIGTERM'), 90_000);
    command.stderr.on('data', (value) => { stderr += String(value); });
    command.on('error', (error) => { clearTimeout(timeout); reject(error); });
    command.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || (signal ? `pg_dump terminated by ${signal}` : `pg_dump exited with ${code}`)));
    });
  });
}

async function checksum(filePath: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function selectRun(pool: Pool, policy: Settings, now: Date): Promise<Run | null> {
  const manual = await pool.query<Run>(`SELECT id, trigger FROM backup_runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`);
  if (manual.rowCount) {
    await pool.query(`UPDATE backup_runs SET status = 'running', started_at = now() WHERE id = $1`, [manual.rows[0].id]);
    return manual.rows[0];
  }
  if (!isDue(policy, now)) return null;
  const recent = await pool.query(`SELECT 1 FROM backup_runs WHERE trigger = $1 AND status = 'succeeded' AND started_at >= date_trunc('hour', now())`, [policy.backup_frequency]);
  if (recent.rowCount) return null;
  const created = await pool.query<Run>(`INSERT INTO backup_runs (status, trigger, started_at) VALUES ('running', $1, now()) RETURNING id, trigger`, [policy.backup_frequency]);
  return created.rows[0];
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for backups.');
  if (!backupStorageIsConfigured()) throw new Error('Railway object storage is required for backups.');
  const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.PGSSLMODE === 'disable' ? undefined : { rejectUnauthorized: false } });
  let temporaryPath: string | undefined;
  let selectedRun: Run | null = null;
  try {
    await pool.query('BEGIN');
    try {
      const settings = await pool.query<Settings>('SELECT backup_frequency, backup_enabled, backup_day_of_week, backup_day_of_month, backup_hour_utc FROM platform_settings WHERE id = true');
      selectedRun = settings.rows[0] ? await selectRun(pool, settings.rows[0], new Date()) : null;
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
    if (!selectedRun) {
      console.log('No queued or scheduled backup is due.');
      return;
    }
    const runId = selectedRun.id;
    temporaryPath = path.join(os.tmpdir(), `bugflow-${randomUUID()}.dump`);
    try {
      await runPgDump(databaseUrl, temporaryPath);
      const stat = await fs.stat(temporaryPath);
      const digest = await checksum(temporaryPath);
      const key = backupStorageKey(runId);
      await uploadBackupArchive({ key, filePath: temporaryPath, byteSize: stat.size, checksum: digest });
      await pool.query(`UPDATE backup_runs SET status = 'succeeded', storage_key = $1, byte_size = $2, checksum = $3, completed_at = now() WHERE id = $4`, [key, stat.size, digest, runId]);
      console.log(`Backup ${runId} succeeded.`);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2000) : 'Unknown backup failure';
      await pool.query(`UPDATE backup_runs SET status = 'failed', error_message = $1, completed_at = now() WHERE id = $2`, [message, runId]);
      throw error;
    }
  } finally {
    if (temporaryPath) await fs.unlink(temporaryPath).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error) => {
  console.error('BugFlow backup worker failed:', error);
  process.exitCode = 1;
});
