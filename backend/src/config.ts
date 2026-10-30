import 'dotenv/config';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing env ${k}`);
  return v;
};

export const config = {
  port: Number(env('PORT', '4000')),
  appUrl: env('APP_URL', 'http://localhost:5173'),
  corsOrigin: env('CORS_ORIGIN', 'http://localhost:5173'),
  databaseUrl: env('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL,
  jwtSecret: env('JWT_SECRET'),
  encryptionKey: env('ENCRYPTION_KEY'),
  isProd: process.env.NODE_ENV === 'production',
  allowSignup: process.env.ALLOW_SIGNUP ? process.env.ALLOW_SIGNUP === 'true' : process.env.NODE_ENV !== 'production',
  metricsToken: process.env.METRICS_TOKEN ?? '',
  /** Suspending a customer needs a second operator's approval. Turn off only for single-operator installations. */
  platformTwoPerson: process.env.PLATFORM_TWO_PERSON !== 'false',
  r2: {
    accountId: process.env.R2_ACCOUNT_ID ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    bucket: process.env.R2_BUCKET ?? '',
    signedTtl: Number(env('SIGNED_URL_TTL_SECONDS', '300')),
  },
  sendgridKey: process.env.SENDGRID_API_KEY ?? '',
  mailFrom: env('MAIL_FROM', 'billing@example.com'),
  stripeKey: process.env.STRIPE_SECRET_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  oxrAppId: process.env.OXR_APP_ID ?? '',
  xero: { id: process.env.XERO_CLIENT_ID ?? '', secret: process.env.XERO_CLIENT_SECRET ?? '' },
  qbo: { id: process.env.QBO_CLIENT_ID ?? '', secret: process.env.QBO_CLIENT_SECRET ?? '' },
};

/** Refuse to boot in production with weak or development settings. Called from server.ts (tests and dev are unaffected). */
export function assertProductionConfig(c: typeof config = config): string[] {
  const bad: string[] = [];
  if (c.jwtSecret.length < 32 || /change|secret|example|dev/i.test(c.jwtSecret)) bad.push('JWT_SECRET must be a random string of 32+ characters');
  if (!/^[0-9a-f]{64}$/i.test(c.encryptionKey)) bad.push('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  if (!c.appUrl.startsWith('https://')) bad.push('APP_URL must be https://');
  if (!c.corsOrigin.startsWith('https://') || c.corsOrigin.includes('*')) bad.push('CORS_ORIGIN must be a single https:// origin');
  if (/localhost|127\.0\.0\.1/.test(c.appUrl + c.corsOrigin)) bad.push('APP_URL / CORS_ORIGIN point at localhost');
  if (!c.r2.bucket || !c.r2.accessKeyId) bad.push('R2_* storage is not configured (files would fall back to local disk)');
  if (c.stripeKey && !c.stripeWebhookSecret) bad.push('STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set');
  if (!c.sendgridKey) bad.push('SENDGRID_API_KEY is not set (no email will be delivered)');
  return bad;
}
