// Auth Helpers for E2E Tests
//
// Provides reusable login functions for each role using the seed data
// credentials from supabase/migrations/006_seed_data.sql.
//
// All test users share the password 'Test1234!' with role-specific emails.

/** Test user credentials from seed data */
export const TEST_USERS = {
  owner: { email: 'owner@test.com', password: 'Test1234!', name: 'Nguyen Van An' },
  manager: { email: 'manager@test.com', password: 'Test1234!', name: 'Tran Thi Binh' },
  staff: { email: 'staff@test.com', password: 'Test1234!', name: 'Le Van Cuong' },
  cashier: { email: 'cashier@test.com', password: 'Test1234!', name: 'Pham Thi Dung' },
  warehouse: { email: 'warehouse@test.com', password: 'Test1234!', name: 'Hoang Van Em' },
};

/**
 * Log in as a specific role via the login page form.
 * Waits for the login form to appear, fills in credentials, submits,
 * and waits for navigation away from the login page.
 *
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @param {'owner' | 'manager' | 'staff' | 'cashier' | 'warehouse'} role - User role
 * @returns {Promise<void>}
 */
export async function loginAs(page, role) {
  const user = TEST_USERS[role];
  if (!user) {
    throw new Error(`Unknown test role: ${role}`);
  }

  // Navigate to the app root (router will redirect to login if not authenticated)
  await page.goto('/');

  // Wait for the login form to render (Alpine.js dynamic page load)
  await page.waitForSelector('#login-email', { state: 'visible', timeout: 10000 });

  // Fill in email and password
  await page.fill('#login-email', user.email);
  await page.fill('#login-password', user.password);

  // Submit the login form
  await page.click('button[type="submit"]');

  // Wait for navigation away from login page (hash changes to a landing route)
  // The router redirects authenticated users to their role-appropriate landing page
  await page.waitForFunction(
    () => !window.location.hash.includes('/login'),
    { timeout: 15000 },
  );

  // Wait for the page container to have content (page template loaded)
  await page.waitForSelector('#page-container > *', { state: 'visible', timeout: 10000 });
}
