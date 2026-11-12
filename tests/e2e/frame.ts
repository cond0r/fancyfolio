import type { Page } from '@playwright/test';

export async function frame(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}
