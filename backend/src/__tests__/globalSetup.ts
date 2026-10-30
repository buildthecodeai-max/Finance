import mysql from 'mysql2/promise';
import { migrate } from '../migrate.js';

// Fresh schema for every `npm test` run. Refuses to touch anything not named *_test.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'mysql://root@localhost:3306/travelfinance_test';
  const u = new URL(url); const db = u.pathname.slice(1);
  if (!db.endsWith('_test')) throw new Error(`Refusing to reset non-test database "${db}"`);
  const admin = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
  await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4`);
  await admin.end();
  await migrate(url, () => {});
}
