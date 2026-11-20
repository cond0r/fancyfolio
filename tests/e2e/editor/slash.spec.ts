import { expect, type Page, test } from '@playwright/test';

const fields = (page: Page) => page.locator('[data-ff-editor] [data-field]');
const list = (page: Page) => page.getByRole('listbox');
const options = (page: Page) => page.getByRole('option');
const blockAt = (page: Page, index: number) =>
  fields(page).nth(index).locator('xpath=ancestor::*[@data-block-id][1]');

async function open(page: Page) {
  await page.goto('/playground');
  await expect(fields(page)).toHaveCount(8);
  await page.waitForLoadState('networkidle');
}

async function slash(page: Page, text: string, after = 1) {
  await fields(page).nth(after).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

test('/hea lists the headings, the field is their combobox, and a pick turns the paragraph', async ({
  page,
}) => {
  await open(page);
  await slash(page, '/hea');
  const field = fields(page).nth(2);
  await expect(options(page)).toHaveText(['Heading 1', 'Heading 2', 'Heading 3']);
  await page.keyboard.press('ArrowDown');
  const active = page.locator('[role="option"][aria-selected="true"]');
  await expect(active).toHaveText('Heading 2');
  await expect(field).toHaveAttribute('role', 'combobox');
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  await expect(field).toHaveAttribute('aria-controls', (await list(page).getAttribute('id')) ?? '');
  await expect(field).toHaveAttribute(
    'aria-activedescendant',
    (await active.getAttribute('id')) ?? '',
  );
  await expect(page.locator('[data-ff-announce]')).toHaveText('Heading 2');
  await page.keyboard.press('Enter');
  await expect(list(page)).toBeHidden();
  await expect(blockAt(page, 2).locator('h2')).toHaveCount(1);
  await expect(fields(page).nth(2)).toHaveText('');
  await expect(fields(page).nth(2)).toBeFocused();
  await expect(fields(page).nth(2)).toHaveAttribute('role', 'textbox');
  await expect(fields(page).nth(2)).not.toHaveAttribute('aria-expanded');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(fields(page).nth(2)).toHaveText('/hea');
  await expect(blockAt(page, 2)).toHaveAttribute('data-block-type', 'paragraph');
  await fields(page).nth(2).press('End');
  await options(page).getByText('Heading 3').click();
  await expect(blockAt(page, 2).locator('h3')).toHaveCount(1);
});

test('/met gives a metric; in a callout child /call lists nothing and Enter splits', async ({
  page,
}) => {
  await open(page);
  await slash(page, '/met');
  await page.keyboard.press('Enter');
  await expect(blockAt(page, 2)).toHaveAttribute('data-block-type', 'metric');
  await expect(fields(page).nth(2)).toHaveAttribute('data-field', 'value');
  await expect(fields(page).nth(2)).toBeFocused();
  await slash(page, '/call', 9);
  await expect(list(page)).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(fields(page)).toHaveCount(12);
  await expect(fields(page).nth(10)).toHaveText('/call');
  await expect(fields(page).nth(11)).toHaveText('');
});

test('Escape keeps / and the list shut for that text; /zzz and Enter split', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page);
  await slash(page, '/');
  await expect(list(page)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+/');
  await expect(page.getByRole('menu').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="listbox"]:popover-open')).toBeVisible();
  expect(errors).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(list(page)).toBeHidden();
  await expect(fields(page).nth(2)).toHaveText('/');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await expect(list(page)).toBeHidden();
  await page.keyboard.type('zzz');
  await page.keyboard.press('Enter');
  await expect(fields(page)).toHaveCount(10);
  await expect(fields(page).nth(2)).toHaveText('/zzz');
});

test('Escape while an input method composes leaves the list open', { tag: '@ime' }, async ({
  page,
}) => {
  await open(page);
  await slash(page, '/');
  await expect(list(page)).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press('Escape');
  await expect(fields(page).nth(2)).toHaveAttribute('aria-expanded', 'true');
});

test('/ after other text or in a heading opens nothing', async ({ page }) => {
  await open(page);
  await fields(page).nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.type('/');
  await expect(list(page)).toBeHidden();
  await slash(page, '/hea', 3);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(fields(page).nth(4)).toHaveText('/');
  await expect(list(page)).toBeHidden();
});
