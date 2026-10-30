// Applies sql/migrations/NNN_*.sql in order, once each. Usage: npm run migrate   (honours DATABASE_URL)
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

export async function migrate(databaseUrl: string, log = console.log) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../sql/migrations');
  const c = await mysql.createConnection({ uri: databaseUrl, multipleStatements: true });
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(100) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const [done]: any = await c.query('SELECT name FROM schema_migrations');
    const applied = new Set(done.map((r: any) => r.name));
    for (const f of (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(f)) continue;
      log(`applying ${f}`);
      await c.query(await fs.readFile(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES (?)', [f]);
    }
  } finally { await c.end(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  await migrate(process.env.DATABASE_URL!);
}
