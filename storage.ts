import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const bucket = process.env.BUCKET;

const client = bucket && process.env.ACCESS_KEY_ID && process.env.SECRET_ACCESS_KEY && process.env.ENDPOINT
  ? new S3Client({
      region: process.env.REGION ?? 'auto',
      endpoint: process.env.ENDPOINT,
      credentials: {
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_ACCESS_KEY,
      },
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    })
  : null;

export function storageIsConfigured() {
  return Boolean(client && bucket);
}

export function attachmentKey(organizationId: string, filename: string) {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'attachment';
  return `organizations/${organizationId}/attachments/${randomUUID()}-${safeFilename}`;
}

export async function uploadAttachment(input: {
  key: string;
  body: Uint8Array;
  contentType: string;
  originalFilename: string;
}) {
  if (!client || !bucket) {
    throw new Error('Railway Object Storage is not configured.');
  }
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: input.key,
    Body: input.body,
    ContentType: input.contentType,
    Metadata: {
      originalFilename: input.originalFilename,
    },
  }));
}

export async function signedAttachmentUrl(key: string, expiresInSeconds = 300) {
  if (!client || !bucket) {
    throw new Error('Railway Object Storage is not configured.');
  }
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds });
}
