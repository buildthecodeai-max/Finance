import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Dev fallback: with no R2 credentials, files go to ./.local-storage and are served via HMAC-signed, expiring URLs.
export const useLocal = !config.r2.accessKeyId;
export const LOCAL_DIR = path.resolve('.local-storage');
const hmac = (key: string, exp: number) => crypto.createHmac('sha256', config.jwtSecret).update(`${key}.${exp}`).digest('hex');
export function verifyLocal(key: string, exp: number, sig: string) {
  const ok = Buffer.from(sig).length === 64 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac(key, exp)));
  return ok && exp > Date.now() / 1000 && !key.includes('..');
}

// Cloudflare R2 via S3-compatible API. Bucket stays private; access only via short-lived signed URLs.
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: config.r2.accessKeyId, secretAccessKey: config.r2.secretAccessKey },
});

/** Keys are always prefixed with the agency id so a key can never be guessed across tenants. */
export const fileKey = (agencyId: number, folder: string, name: string) =>
  `agency-${agencyId}/${folder}/${Date.now()}-${name.replace(/[^\w.\-]/g, '_')}`;

export async function putFile(key: string, body: Buffer | string, contentType: string) {
  if (useLocal) {
    const f = path.join(LOCAL_DIR, key); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, body); return key;
  }
  await s3.send(new PutObjectCommand({ Bucket: config.r2.bucket, Key: key, Body: body, ContentType: contentType }));
  return key;
}

export async function signedUrl(agencyId: number, key: string, filename?: string) {
  if (!key.startsWith(`agency-${agencyId}/`)) throw new Error('Forbidden key');
  if (useLocal) {
    const exp = Math.floor(Date.now() / 1000) + config.r2.signedTtl;
    return `/api/dev-files?key=${encodeURIComponent(key)}&exp=${exp}&sig=${hmac(key, exp)}&name=${encodeURIComponent(filename ?? '')}`;
  }
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.r2.bucket,
      Key: key,
      ResponseContentDisposition: filename ? `attachment; filename="${filename}"` : undefined,
    }),
    { expiresIn: config.r2.signedTtl },
  );
}
