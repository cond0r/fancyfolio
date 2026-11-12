import { expect, type Locator, type Page, test } from '@playwright/test';
import { frame } from '../frame.ts';

const fields = (page: Page) => page.locator('[data-ff-editor] [data-field]');
const metric = (page: Page) => page.locator('[data-ff-editor] figure [data-field]');
const callout = (page: Page) => page.locator('[data-ff-editor] aside [data-field]');
const note = 'The shop and its numbers are invented.';

async function open(page: Page) {
  await page.goto('/playground');
  await expect(callout(page)).toHaveText([note]);
  await page.waitForLoadState('networkidle');
}

async function caretAtEnd(page: Page, field: Locator) {
  await field.click();
  await page.keyboard.press('End');
}

test('metric fields are edited in place and Enter in them adds nothing', async ({ page }) => {
  await open(page);
  const count = await fields(page).count();
  await caretAtEnd(page, metric(page).nth(0));
  await page.keyboard.type(' left');
  await caretAtEnd(page, metric(page).nth(1));
  await page.keyboard.type(' today');
  await page.keyboard.press('Enter');
  await caretAtEnd(page, metric(page).nth(0));
  await page.keyboard.press('Enter');
  await expect(metric(page)).toHaveText(['3 steps left', 'Checkout length today']);
  await expect(fields(page)).toHaveCount(count);
});

test('Enter in an empty last callout child moves the caret out of the callout', async ({
  page,
}) => {
  await open(page);
  await caretAtEnd(page, callout(page).first());
  await page.keyboard.press('Enter');
  await expect(callout(page)).toHaveText([note, '']);
  await page.keyboard.press('Enter');
  await expect(callout(page)).toHaveText([note]);
  await page.keyboard.type('Outside');
  await expect(fields(page).last()).toHaveText('Outside');
  await expect(callout(page)).toHaveText([note]);
});

test('emptying the callout leaves one empty paragraph in it', async ({ page }) => {
  await open(page);
  await caretAtEnd(page, callout(page).first());
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Backspace');
  await expect(callout(page)).toHaveText(['']);
  await page.keyboard.press('Enter');
  await expect(callout(page)).toHaveText(['']);
  await page.keyboard.type('Outside');
  await expect(fields(page).last()).toHaveText('Outside');
  await expect(callout(page)).toHaveText(['']);
});

test('an attribute payload typed into a metric stays text', async ({ page }) => {
  await open(page);
  const quoted = '" onmouseover="alert(1)';
  const scripted = 'javascript:alert(1)';
  await caretAtEnd(page, metric(page).nth(0));
  await page.keyboard.type(quoted);
  await caretAtEnd(page, metric(page).nth(1));
  await page.keyboard.type(scripted);
  await expect(metric(page)).toHaveText([`3 steps${quoted}`, `Checkout length${scripted}`]);
  await expect(page.locator('[data-ff-editor] [onmouseover]')).toHaveCount(0);
  await expect(page.locator('[data-ff-editor] [href]')).toHaveCount(0);
});

test('a drag from the metric onto callout text selects both; Backspace removes them', async ({
  page,
}) => {
  await open(page);
  const from = await metric(page).nth(1).boundingBox();
  const to = await callout(page).first().boundingBox();
  if (from === null || to === null) throw new Error('the fields have no box');
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('[data-block-id][data-selected]')).toHaveCount(2);
  await page.keyboard.press('Backspace');
  await expect(metric(page)).toHaveCount(0);
  await expect(callout(page)).toHaveCount(0);
});

test('a keystroke in a callout child commits exactly that child', async ({ page }) => {
  await open(page);
  const commits = page.getByTestId('commits');
  await caretAtEnd(page, callout(page).first());
  await commits.evaluate((output) => output.replaceChildren());
  await page.keyboard.type('x');
  await expect(callout(page)).toHaveText([`${note}x`]);
  await expect.poll(() => commits.textContent()).not.toBe('');
  await frame(page);
  const child = await callout(page)
    .first()
    .evaluate((field) => field.closest<HTMLElement>('[data-block-id]')?.dataset.blockId);
  expect((await commits.textContent())?.trim().split(' ')).toEqual([child]);
});
