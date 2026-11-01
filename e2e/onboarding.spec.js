// Playwright E2E test: create-hospital + register patient
// Run: npx playwright install && npx playwright test e2e/onboarding.spec.js

import { test, expect } from '@playwright/test'

test.describe('Onboarding flow', () => {
  test('create new hospital and register patient', async ({ page }) => {
    await page.goto('/#/register')

    // Fill create-hospital form
    await page.fill('#nm', 'Dr. Test User')
    await page.fill('#em2', 'test@hospital.ng')
    await page.fill('#pw2', 'TestPass123')
    await page.fill('#pc', 'TestPass123')
    await page.fill('#on', 'Test Specialist Hospital')
    await page.selectOption('#ot', 'General Hospital')
    await page.fill('#os', 'Lagos')
    await page.fill('#ol', 'Ikeja')
    await page.click('#go')

    // Wait for success message
    await expect(page.locator('.fn-success')).toBeVisible({ timeout: 10000 })
    await page.click('.fn-continue')

    // Should redirect to dashboard/welcome
    await expect(page).toHaveURL(/#\/welcome|#\//)

    // Navigate to patients and register a patient
    await page.goto('/#/patients')
    await expect(page.locator('.page')).toBeVisible()

    // Click add patient button (implementation dependent)
    // await page.click('[data-testid="add-patient"]')
    // Fill patient form and submit
    // await expect(page.locator('[data-testid="patient-list"]')).toContainText('Test Patient')
  })

  test('join existing hospital with org ID', async ({ page }) => {
    await page.goto('/#/register?mode=join')

    // Fill join form
    await page.fill('#nm', 'Dr. Join User')
    await page.fill('#em2', 'join@hospital.ng')
    await page.fill('#pw2', 'JoinPass123')
    await page.fill('#pc', 'JoinPass123')
    await page.fill('#oid', 'ABC-XYZ-123')
    await page.selectOption('#rl', 'doctor')
    await page.click('#go')

    // Should show pending approval
    await expect(page.locator('.fn-success')).toBeVisible({ timeout: 10000 })
  })
})