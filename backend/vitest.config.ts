import { defineConfig } from 'vitest/config';

export const TEST_DB = 'travelfinance_test';
export default defineConfig({
  test: {
    globalSetup: ['./src/__tests__/globalSetup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    fileParallelism: false, // one shared MySQL schema
    testTimeout: 20000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? `mysql://root@localhost:3306/${TEST_DB}`,
      JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
      ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      APP_URL: 'http://localhost:5173', CORS_ORIGIN: 'http://localhost:5173',
    },
  },
});
