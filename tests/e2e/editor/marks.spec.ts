import { expect, type Locator, type Page, test } from '@playwright/test';
import { frame } from '../frame.ts';

const fields = (page: Page) => page.locator('[data-ff-editor] [data-field]');
const blockOf = (inner: Locator) => inner.locator('xpath=ancestor::*[@data-block-id][1]');
const selected = (page: Page) => page.evaluate(() => document.getSelection()?.toString());

async function open(page: Page) {
  await page.goto('/playground');
  await expect(fields(page)).toHaveCount(9);
  await page.waitForLoadState('networkidle');
}

async function select(page: Page, index: number, from: number, to: number) {
  await fields(page)
    .nth(index)
    .click({ position: { x: 1, y: 4 } });
  await page.keyboard.press('Home');
  for (let step = 0; step < from; step += 1) await page.keyboard.press('ArrowRight');
  for (let step = from; step < to; step += 1) await page.keyboard.press('Shift+ArrowRight');
}

async function clickAfter(page: Page, index: number, char: number) {
  const box = await fields(page)
    .nth(index)
    .evaluate((field, char) => {
      const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
      let left = char;
      for (let node = walker.nextNode(); node instanceof Text; node = walker.nextNode()) {
        if (left < node.length) {
          const range = document.createRange();
          range.setStart(node, left);
          range.setEnd(node, left + 1);
          const { right, top, height } = range.getBoundingClientRect();
          return { x: right - 1, y: top + height / 2 };
        }
        left -= node.length;
      }
      throw new Error(`no character ${char}`);
    }, char);
  await page.mouse.click(box.x, box.y);
}

for (const width of [1280, 390]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('a shortcut marks the selected word, keeps it selected and undoes', async ({ page }) => {
      await open(page);
      const field = fields(page).nth(2);
      const id = await blockOf(field).getAttribute('data-block-id');
      const commits = page.getByTestId('commits');
      for (const [keys, tag] of [
        ['ControlOrMeta+b', 'strong'],
        ['ControlOrMeta+i', 'em'],
        ['ControlOrMeta+Shift+x', 's'],
        ['ControlOrMeta+e', 'code'],
      ] as const) {
        await commits.evaluate((output) => output.replaceChildren());
        await select(page, 2, 4, 12);
        await frame(page);
        expect(await commits.textContent()).toBe('');
        await page.keyboard.press(keys);
        await expect(field.locator(tag)).toHaveText('checkout');
        expect(await selected(page)).toBe('checkout');
        await frame(page);
        const rendered = (await commits.textContent())?.trim().split(/\s+/);
        expect(new Set(rendered)).toEqual(new Set([id]));
        await page.keyboard.press('ControlOrMeta+z');
        await expect(field.locator(tag)).toHaveCount(0);
        await expect(field).toHaveText('Its checkout took nine steps.');
      }
    });

    test('a caret shortcut marks what is typed next; typing after a mark inherits it but code', async ({
      page,
    }) => {
      await open(page);
      const field = fields(page).nth(4);
      await field.click();
      await page.keyboard.press('End');
      await page.keyboard.press('ControlOrMeta+b');
      await page.keyboard.type('ab');
      await expect(field.locator('strong')).toHaveText('ab');
      await select(page, 4, 6, 11);
      await page.keyboard.press('ControlOrMeta+b');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.type('X');
      await expect(field.locator('strong').first()).toHaveText('stepsX');
      await select(page, 4, 0, 5);
      await page.keyboard.press('ControlOrMeta+e');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.type('Y');
      await expect(field.locator('code')).toHaveText('Three');
      await expect(field).toHaveText('ThreeY stepsX remained.ab');
    });

    for (const [name, index, from, to] of [
      ['heading', 0, 6, 11],
      ['paragraph', 1, 9, 19],
      ['callout child', 7, 4, 8],
    ] as const) {
      test(`arrows and a click across a mark boundary in a ${name} type where the caret shows`, async ({
        page,
      }) => {
        await open(page);
        const field = fields(page).nth(index);
        const text = (await field.textContent()) ?? '';
        await select(page, index, from, to);
        await page.keyboard.press('ControlOrMeta+b');
        await expect(field.locator('strong')).toHaveText(text.slice(from, to));
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.type('Z');
        const typed = `${text.slice(0, from + 1)}Z${text.slice(from + 1)}`;
        await expect(field).toHaveText(typed);
        await clickAfter(page, index, to);
        await page.keyboard.type('W');
        await expect(field).toHaveText(`${typed.slice(0, to + 1)}W${typed.slice(to + 1)}`);
      });
    }

    test('markup typed into a bold mark renders as text', async ({ page }) => {
      await open(page);
      const field = fields(page).nth(2);
      await select(page, 2, 4, 12);
      await page.keyboard.press('ControlOrMeta+b');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.type('<b>x</b>');
      await expect(field.locator('strong')).toHaveText('c<b>x</b>heckout');
      await expect(field.locator('b')).toHaveCount(0);
    });
  });
}
