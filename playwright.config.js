// Playwright E2E test configuration for F&B Multi-Channel Management App
//
// Configures test directory, timeouts, retries, and browser projects.
// Uses hash-based SPA routing served via a local static file server.
//
// Prerequisites:
//   npm install --save-dev @playwright/test
//   npx playwright install
//
// Usage:
//   npx playwright test                       # Run all E2E tests
//   npx playwright test --project=chromium    # Desktop Chrome only
//   npx playwright test --project=mobile-chrome  # Mobile Pixel 5 only
//   npx playwright test --headed              # Run with visible browser
//
// Design reference: Section 9.3 E2E Testing Framework

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // Test files location
  testDir: './tests/e2e',

  // Maximum time a single test can run (30 seconds)
  timeout: 30000,

  // Retry failed tests once to account for flaky network/timing issues
  retries: 1,

  // Shared settings for all projects
  use: {
    // Base URL for the local dev server serving the SPA
    baseURL: 'http://localhost:3000',

    // Capture screenshot only when a test fails (saves disk space)
    screenshot: 'only-on-failure',

    // Record trace on first retry for debugging flaky tests
    trace: 'on-first-retry',

    // Wait for Alpine.js and Supabase to initialize before interactions
    actionTimeout: 10000,
  },

  // Browser/device configurations to test against
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],

  // Output directory for test artifacts (screenshots, traces)
  outputDir: './tests/e2e/test-results',
});
