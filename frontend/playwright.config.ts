import { defineConfig } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:8010',
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN',
    launchOptions: fs.existsSync(edge) ? { executablePath: edge } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: '"' + path.resolve('../.venv/Scripts/python.exe') + '" -m uvicorn app.main:app --app-dir "' + path.resolve('../backend') + '" --host 127.0.0.1 --port 8010',
    url: 'http://127.0.0.1:8010/api/v1/health',
    timeout: 30000,
    reuseExistingServer: false,
    env: { PLANNER_DATA_DIR: path.resolve('../data/e2e-' + Date.now()) }
  },
  reporter: [['list'], ['json', { outputFile: '../docs/playwright-results.json' }]]
});
