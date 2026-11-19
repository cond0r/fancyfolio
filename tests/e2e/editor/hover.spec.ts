import { expect, type Locator, type Page, test } from '@playwright/test';
import { frame, type Sample, sampler } from '../frame.ts';

const chrome = '[data-ff-chrome]';
const fields = (page: Page) => page.locator('[data-ff-editor] [data-field]');
const handle = (page: Page) => page.locator('[data-ff-handle]');
const translate = (page: Page) => page.locator(chrome).evaluate((node) => node.style.translate);

type Point = { readonly x: number; readonly y: number };

const shown = (samples: readonly Sample[], from?: string) =>
  [from, ...samples.map((sample) => (sample.visible ? sample.translate : 'hidden'))].filter(
    (each, index, all) => each !== undefined && each !== all[index - 1],
  );

const afterLastOver = (samples: readonly Sample[]) => {
  const last = Math.max(...samples.map((sample) => sample.overs));
  return shown(samples.filter((sample) => sample.overs === last))[0];
};

async function glide(page: Page, from: Point, to: Point) {
  const steps = Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / 2);
  for (let step = 1; step <= steps; step += 1) {
    const at = step / steps;
    await page.mouse.move(from.x + (to.x - from.x) * at, from.y + (to.y - from.y) * at);
    await frame(page);
  }
}

async function open(page: Page) {
  await page.goto('/playground');
  await expect(fields(page)).toHaveCount(8);
  await page.waitForLoadState('networkidle');
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element has no box');
  return box;
}

const lineOf = (page: Page, index: number) =>
  fields(page)
    .nth(index)
    .evaluate((field) => {
      const range = document.createRange();
      range.selectNodeContents(field);
      const line = range.getClientRects()[0] ?? field.getBoundingClientRect();
      return { x: line.x + 4, y: line.y + line.height / 2 };
    });

for (const width of [1280, 390]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('a hover moves the chrome in the next frame, never via a third', async ({ page }) => {
      await open(page);
      await fields(page).nth(7).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await expect(fields(page)).toHaveCount(9);
      const read = await sampler(page, chrome);
      for (const [from, to, hop] of [
        [1, 2, false],
        [7, 8, false],
        [1, 4, true],
        [-1, 2, true],
      ] as const) {
        const [a, b] = await Promise.all([lineOf(page, Math.max(from, 0)), lineOf(page, to)]);
        await page.mouse.move(from < 0 ? 2 : a.x, from < 0 ? 2 : a.y);
        await frame(page);
        const start = from < 0 ? 'hidden' : await translate(page);
        await read();
        if (hop) await page.mouse.move(a.x, b.y);
        else await glide(page, a, { x: a.x, y: b.y });
        const samples = await read();
        const end = await translate(page);
        expect(shown(samples, start)).toEqual([start, end]);
        expect(afterLastOver(samples)).toBe(end);
      }
    });

    test('leaving sideways hides the chrome in place; typing brings it back', async ({ page }) => {
      await open(page);
      const read = await sampler(page, chrome);
      const line = await lineOf(page, 4);
      let start = '';
      for (const focused of [false, true]) {
        if (focused) await fields(page).nth(4).click();
        else await page.mouse.move(line.x, line.y);
        await frame(page);
        start = await translate(page);
        await read();
        await page.mouse.move(width - 2, line.y);
        const samples = await read();
        expect(shown(samples, start)).toEqual([start, 'hidden']);
        expect(afterLastOver(samples)).toBe('hidden');
        expect(new Set(samples.map((sample) => sample.translate))).toEqual(new Set([start]));
      }
      await page.keyboard.type('x');
      await expect(handle(page)).toBeVisible();
      await expect(handle(page)).toHaveAccessibleName('Text options, 5 of 7');
      expect(await translate(page)).toBe(start);
    });

    test('a child keeps its chrome, left of the border in one column; left of it is the callout', async ({
      page,
    }) => {
      await open(page);
      const read = await sampler(page, chrome);
      const columns: number[] = [];
      for (const index of [1, 7]) {
        const line = await lineOf(page, index);
        await page.mouse.move(line.x, line.y);
        await frame(page);
        const start = await translate(page);
        await read();
        const [cog, plus, grip] = await Promise.all(
          [handle(page), page.locator('[data-ff-insert]'), page.locator('[data-ff-grip]')].map(
            boxOf,
          ),
        );
        expect([cog.x < plus.x, plus.x < grip.x]).toEqual([true, true]);
        await glide(page, line, { x: cog.x + cog.width / 2, y: line.y });
        expect(shown(await read(), start)).toEqual([start]);
        columns.push((await boxOf(page.locator(chrome))).x);
      }
      const aside = await boxOf(page.locator('[data-ff-editor] aside'));
      const child = await lineOf(page, 7);
      await page.mouse.move(aside.x + 8, child.y);
      await expect(handle(page)).toHaveAccessibleName('Text options, 1 of 1 in Callout');
      const inner = await boxOf(handle(page));
      const nested = await boxOf(page.locator(chrome));
      expect(nested.x + nested.width).toBeLessThanOrEqual(aside.x);
      await page.mouse.move(2, child.y);
      await page.mouse.move(aside.x - 10, child.y);
      await expect(handle(page)).toHaveAccessibleName('Callout options, 7 of 7');
      const outer = await boxOf(handle(page));
      columns.push(nested.x, (await boxOf(page.locator(chrome))).x);
      expect(Math.max(...columns) - Math.min(...columns)).toBeLessThan(1);
      expect(Math.min(...columns)).toBeGreaterThanOrEqual(0);
      expect(Math.abs(outer.y - aside.y)).toBeLessThan(1);
      expect(inner.y - outer.y).toBeGreaterThan(2);
    });

    test('a gutter press selects no block and keeps the focus', async ({ page }) => {
      await open(page);
      await fields(page).nth(1).click();
      const metric = await boxOf(page.locator('[data-ff-editor] figure'));
      const child = await lineOf(page, 7);
      await page.mouse.move(metric.x - 20, metric.y + metric.height - 10);
      await page.mouse.down();
      await page.mouse.move(child.x, child.y, { steps: 5 });
      await page.mouse.up();
      await expect(page.locator('[data-selected]')).toHaveCount(0);
      await expect(fields(page).nth(1)).toBeFocused();
    });

    test('deleting the hovered last block hides the chrome', async ({ page }) => {
      await open(page);
      const asides = page.locator('[data-ff-editor] aside');
      const aside = await boxOf(asides);
      await page.mouse.move(aside.x + 40, aside.y + 4);
      await handle(page).click();
      await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
      await expect(asides).toHaveCount(2);
      const copy = await boxOf(asides.nth(1));
      await page.mouse.move(2, 2);
      await page.mouse.move(copy.x + 40, copy.y + 4);
      await expect(handle(page)).toHaveAccessibleName('Callout options, 8 of 8');
      await page.keyboard.press('ControlOrMeta+z');
      await expect(fields(page)).toHaveCount(8);
      await expect(handle(page)).toBeHidden();
    });

    test('the handle centres on the first text line of each block type', async ({ page }) => {
      await open(page);
      for (const index of [0, 1, 5]) {
        const line = await lineOf(page, index);
        await page.mouse.move(line.x, line.y);
        await frame(page);
        const box = await boxOf(handle(page));
        expect(Math.abs(box.y + box.height / 2 - line.y)).toBeLessThan(2);
      }
    });

    test('Ctrl+/ in a callout child pins the chrome while others are hovered', async ({ page }) => {
      await open(page);
      await fields(page).nth(7).click();
      await frame(page);
      await page.keyboard.press('ControlOrMeta+/');
      await expect(page.getByRole('menu').first()).toBeVisible();
      const start = await translate(page);
      const read = await sampler(page, chrome);
      for (const index of [1, 4]) {
        const line = await lineOf(page, index);
        await page.mouse.move(line.x, line.y, { steps: 5 });
      }
      expect(shown(await read(), start)).toEqual([start]);
      await expect(handle(page)).toHaveAccessibleName('Text options, 1 of 1 in Callout');
    });
  });
}
