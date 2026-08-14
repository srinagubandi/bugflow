import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import path from 'node:path';

function storageClient() {
  const endpoint = process.env.ENDPOINT;
  const accessKeyId = process.env.ACCESS_KEY_ID;
  const secretAccessKey = process.env.SECRET_ACCESS_KEY;
  const region = process.env.REGION ?? 'auto';
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error('Railway object storage is not configured.');
  return new S3Client({ endpoint, region, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', credentials: { accessKeyId, secretAccessKey } });
}

export function backupStorageIsConfigured() {
  return Boolean(process.env.BUCKET && process.env.ENDPOINT && process.env.ACCESS_KEY_ID && process.env.SECRET_ACCESS_KEY);
}

export function backupStorageKey(runId: string, createdAt = new Date()) {
  const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
  return `platform/backups/${createdAt.getUTCFullYear()}/${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}/bugflow-${stamp}-${runId}.dump`;
}

export async function uploadBackupArchive(input: { key: string; filePath: string; byteSize: number; checksum: string }) {
  const bucket = process.env.BUCKET;
  if (!bucket) throw new Error('Railway backup bucket is not configured.');
  const client = storageClient();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: input.key,
    Body: createReadStream(input.filePath),
    ContentType: 'application/octet-stream',
    ContentLength: input.byteSize,
    Metadata: { kind: 'postgresql-logical-backup', checksum: input.checksum, source: 'bugflow' },
    ContentDisposition: `attachment; filename="${path.basename(input.key)}"`,
  }));
}
