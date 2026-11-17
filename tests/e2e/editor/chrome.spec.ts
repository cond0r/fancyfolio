import { expect, type Page, test } from '@playwright/test';
import { frame } from '../frame.ts';

const fields = (page: Page) => page.locator('[data-ff-editor] [data-field]');
const handle = (page: Page) => page.locator('[data-ff-handle]');
const remove = (page: Page) => page.getByRole('menuitem', { name: 'Delete' });
const blockAt = (page: Page, index: number) =>
  fields(page).nth(index).locator('xpath=ancestor::*[@data-block-id][1]');

async function open(page: Page) {
  await page.goto('/playground');
  await expect(fields(page)).toHaveCount(8);
  await page.waitForLoadState('networkidle');
}

async function faded(page: Page) {
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
}

async function caretAt(page: Page, index: number, offset: number) {
  await fields(page).nth(index).click();
  await page.keyboard.press('Home');
  for (let step = 0; step < offset; step += 1) await page.keyboard.press('ArrowRight');
}

async function dragAcross(page: Page, from: number, to: number) {
  const start = await fields(page).nth(from).boundingBox();
  const end = await fields(page).nth(to).boundingBox();
  if (start === null || end === null) throw new Error('the fields have no box');
  await page.mouse.move(start.x + 10, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 10, end.y + end.height / 2, { steps: 5 });
  await page.mouse.up();
}

test('one handle follows the pointer into a callout and deletes a child', async ({ page }) => {
  await open(page);
  await caretAt(page, 7, 0);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(fields(page)).toHaveCount(9);
  for (const [index, name] of [
    [1, 'Text options, 2 of 7'],
    [7, 'Text options, 1 of 2 in Callout'],
  ] as const) {
    await fields(page).nth(index).hover();
    await expect(handle(page)).toHaveAccessibleName(name);
    const [box, block] = await Promise.all([
      handle(page).boundingBox(),
      blockAt(page, index).boundingBox(),
    ]);
    expect(Math.abs((box?.y ?? 0) - (block?.y ?? Number.POSITIVE_INFINITY))).toBeLessThan(2);
  }
  await expect(handle(page)).toHaveCount(1);
  await handle(page).click();
  await remove(page).click();
  await expect(fields(page)).toHaveCount(8);
  await expect(fields(page).nth(7)).toHaveText('');
});

test('hovering, arrows, a drag selection and the menu commit no block', async ({ page }) => {
  await open(page);
  const commits = page.getByTestId('commits');
  await caretAt(page, 1, 0);
  await commits.evaluate((output) => output.replaceChildren());
  for (const index of [0, 2, 3, 4, 7]) await fields(page).nth(index).hover();
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowDown');
  await expect(fields(page).nth(4)).toBeFocused();
  await dragAcross(page, 1, 2);
  await expect(page.locator('[data-block-id][data-selected]')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+/');
  await expect(remove(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await frame(page);
  expect(await commits.textContent()).toBe('');
});

test('Ctrl+/ opens the menu on Delete; Escape returns the caret; Delete and undo', async ({
  page,
}) => {
  await open(page);
  await fields(page).nth(1).click();
  await page.keyboard.press('Tab');
  await expect(fields(page).nth(2)).toBeFocused();
  await caretAt(page, 2, 3);
  await page.mouse.move(5, 5);
  await page.keyboard.press('ControlOrMeta+/');
  await faded(page);
  await expect(remove(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(fields(page).nth(2)).toBeFocused();
  await page.keyboard.type('X');
  await expect(fields(page).nth(2)).toHaveText('ItsX checkout took nine steps.');
  await page.keyboard.press('ControlOrMeta+/');
  await page.keyboard.press('Enter');
  await expect(fields(page)).toHaveCount(7);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(fields(page)).toHaveCount(8);
  await expect(fields(page).nth(2)).toHaveText('ItsX checkout took nine steps.');
});

test('a block selection is outlined, keeps the callout border and is announced', async ({
  page,
}) => {
  await open(page);
  const aside = page.locator('[data-ff-editor] aside');
  const border = () =>
    aside.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor];
    });
  const before = await border();
  await dragAcross(page, 6, 7);
  const selected = page.locator('[data-block-id][data-selected]');
  await expect(selected).toHaveCount(2);
  await expect(selected.last()).toHaveCSS('outline-style', 'solid');
  expect(await border()).toEqual(before);
  await expect(page.locator('[data-ff-live]')).toHaveText('2 blocks selected');
});

test('Ctrl+Z and Ctrl+S in the open menu leave the text and the focus', async ({ page }) => {
  await open(page);
  const field = fields(page).nth(4);
  await caretAt(page, 4, 0);
  await page.keyboard.press('End');
  await page.keyboard.type('abc');
  await expect(field).toHaveText('Three steps remained.abc');
  await page.keyboard.press('ControlOrMeta+/');
  await expect(remove(page)).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(field).toHaveText('Three steps remained.abc');
  await expect(remove(page)).toBeFocused();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(remove(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(field).toHaveText('Three steps remained.');
});

for (const [name, close] of [
  ['Escape', (page: Page) => page.keyboard.press('Escape')],
  ['a click outside the menu', (page: Page) => page.mouse.click(5, 5)],
] as const) {
  test(`${name} after a pointer-opened menu puts the caret back at its offset`, async ({
    page,
  }) => {
    await open(page);
    await caretAt(page, 2, 5);
    await handle(page).click();
    await page.mouse.move(5, 5);
    await faded(page);
    await expect(handle(page)).toBeVisible();
    await expect(remove(page)).toBeFocused();
    await close(page);
    await expect(fields(page).nth(2)).toBeFocused();
    await page.keyboard.type('X');
    await expect(fields(page).nth(2)).toHaveText('Its cXheckout took nine steps.');
  });
}

test.describe('on a 375 px touch screen', () => {
  test.use({ viewport: { width: 375, height: 640 }, hasTouch: true });

  test('a tapped field shows its handle; the menu fits and follows a scroll', async ({ page }) => {
    await open(page);
    const field = fields(page).nth(1);
    await field.tap();
    await expect(field).toBeFocused();
    await expect(field).toHaveCSS('outline-style', 'none');
    await expect(handle(page)).toBeVisible();
    await expect(handle(page)).toHaveAccessibleName('Text options, 2 of 7');
    expect((await handle(page).boundingBox())?.x).toBeGreaterThanOrEqual(0);
    await handle(page).tap();
    await faded(page);
    await expect(remove(page)).toBeFocused();
    const menu = page.getByRole('menu');
    const box = await menu.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(375);
    const gap = async () => {
      const [menuBox, handleBox] = await Promise.all([
        menu.boundingBox(),
        handle(page).boundingBox(),
      ]);
      return Math.round((menuBox?.y ?? 0) - (handleBox?.y ?? 0));
    };
    const offset = await gap();
    const top = (await handle(page).boundingBox())?.y;
    await page.evaluate(() => {
      document.body.style.paddingBottom = '100vh';
      window.scrollBy(0, 40);
    });
    await expect.poll(async () => (await handle(page).boundingBox())?.y).not.toBe(top);
    await expect.poll(gap).toBe(offset);
    await page.keyboard.press('Escape');
    await expect(field).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(handle(page)).toHaveAccessibleName('Text options, 3 of 7');
    await fields(page).nth(2).blur();
    await fields(page).nth(2).hover();
    await expect(handle(page)).toBeHidden();
  });
});
