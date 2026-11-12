import { expect, type Page, test } from '@playwright/test';
import { body as playground } from '../../../apps/web/app/(app)/playground/fixture.ts';
import { frame } from '../frame.ts';

const body = [
  'Field notes from Larkspur Outfitters',
  'Larkspur Outfitters is an invented outdoor shop.',
  'Its checkout took nine steps.',
  'Result',
  'Three steps remained.',
  '3 steps',
  'Checkout length',
  'The shop and its numbers are invented.',
];

const fields = (page: Page) => page.locator('[data-ff-editor] [data-field]');

async function open(page: Page) {
  await page.goto('/playground');
  await expect(fields(page)).toHaveCount(body.length);
  await page.waitForLoadState('networkidle');
}

async function caretAt(page: Page, index: number, edge: 'Home' | 'End') {
  await fields(page).nth(index).click();
  await page.keyboard.press(edge);
}

test('typing, Enter mid-block and Backspace at a block start edit like plain text', async ({
  page,
}) => {
  await open(page);
  await caretAt(page, 2, 'End');
  await page.keyboard.type(' Now three.');
  await expect(fields(page).nth(2)).toHaveText('Its checkout took nine steps. Now three.');
  await caretAt(page, 2, 'Home');
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(fields(page)).toHaveCount(body.length + 1);
  await expect(fields(page).nth(2)).toHaveText('Its');
  await expect(fields(page).nth(3)).toHaveText('checkout took nine steps. Now three.');
  await page.keyboard.press('Backspace');
  await expect(fields(page)).toHaveCount(body.length);
  await expect(fields(page).nth(2)).toHaveText('Its checkout took nine steps. Now three.');
});

test('arrows cross block edges', async ({ page }) => {
  await open(page);
  await caretAt(page, 1, 'End');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('A');
  await expect(fields(page).nth(2)).toHaveText(`A${body[2]}`);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('B');
  await expect(fields(page).nth(1)).toHaveText(`${body[1]}B`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('C');
  await expect(fields(page).nth(3)).toContainText('C');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('D');
  await expect(fields(page).nth(2)).toContainText('D');
});

test('undo and redo by keyboard restore the text and the caret', async ({ page }) => {
  await open(page);
  await caretAt(page, 4, 'End');
  await page.keyboard.type(' Done.');
  await expect(fields(page).nth(4)).toHaveText(`${body[4]} Done.`);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(fields(page).nth(4)).toHaveText(body[4] ?? '');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(fields(page).nth(4)).toHaveText(`${body[4]} Done.`);
  await page.keyboard.type('!');
  await expect(fields(page).nth(4)).toHaveText(`${body[4]} Done.!`);
});

test('composition commits the composed text once', { tag: '@ime' }, async ({ page }) => {
  await open(page);
  await caretAt(page, 3, 'End');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '日本' });
  await expect(fields(page).nth(3)).toHaveText('Result日本');
  await page.keyboard.type('!');
  await expect(fields(page).nth(3)).toHaveText('Result日本!');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(fields(page).nth(3)).toHaveText('Result');
});

test('a drag across two blocks selects both whole; Backspace removes them in one undo step', async ({
  page,
}) => {
  await open(page);
  const from = await fields(page).nth(1).boundingBox();
  const to = await fields(page).nth(2).boundingBox();
  if (from === null || to === null) throw new Error('the fields have no box');
  const commits = page.getByTestId('commits');
  await commits.evaluate((output) => output.replaceChildren());
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 5 });
  await page.mouse.up();
  const flagged = page.locator('[data-block-id][data-selected]');
  await expect(flagged).toHaveCount(2);
  await frame(page);
  const ids = await flagged.evaluateAll((blocks) => blocks.map((block) => block.dataset.blockId));
  expect((await commits.textContent())?.trim().split(' ').sort()).toEqual(ids.sort());
  await page.keyboard.press('Backspace');
  await expect(fields(page)).toHaveCount(body.length - 2);
  await expect(fields(page).nth(1)).toHaveText(body[3] ?? '');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(fields(page)).toHaveText(body);
  await expect(page.locator('[data-block-id][data-selected]')).toHaveCount(2);
});

test('a keystroke commits exactly one block and the editor sends no request', async ({ page }) => {
  await open(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const commits = page.getByTestId('commits');
  await caretAt(page, 1, 'End');
  await commits.evaluate((output) => output.replaceChildren());
  await page.keyboard.type('x');
  await expect(fields(page).nth(1)).toHaveText(`${body[1]}x`);
  await expect.poll(() => commits.textContent()).not.toBe('');
  await frame(page);
  const ids = (await commits.textContent())?.trim().split(' ');
  const id = await page.locator('[data-block-id]').nth(1).getAttribute('data-block-id');
  expect(ids).toEqual([id]);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(fields(page)).toHaveCount(body.length);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('status')).toHaveText('Saved');
  await frame(page);
  expect(requests).toEqual([]);
});

test('the block chrome removes its block and undo brings it back', async ({ page }) => {
  await open(page);
  const topLevel = playground.trim().split('\n\n').length;
  await expect(page.getByRole('button', { name: 'Remove block' })).toHaveCount(topLevel);
  const block = fields(page).nth(1).locator('xpath=ancestor::*[@data-block-id][1]');
  const remove = block.getByRole('button', { name: 'Remove block' });
  await remove.click();
  await expect(fields(page)).toHaveText(body.filter((_text, index) => index !== 1));
  await page.keyboard.press('ControlOrMeta+z');
  await expect(fields(page)).toHaveText(body);
});

test('no public page loads the editor', async ({ page }) => {
  const scripts: Promise<string>[] = [];
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') scripts.push(response.text());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const sources = await Promise.all(scripts);
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources) expect(source).not.toContain('data-ff-editor');
});
