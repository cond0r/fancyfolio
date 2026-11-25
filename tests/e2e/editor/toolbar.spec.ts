import { expect, type Locator, type Page, test } from '@playwright/test';
import { frame } from '../frame.ts';

const fields = (page: Page) => page.locator('[data-ff-editor] [data-field]');
const blockOf = (inner: Locator) => inner.locator('xpath=ancestor::*[@data-block-id][1]');
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Text formatting' });
const tool = (page: Page, name: string) => toolbar(page).getByRole('button', { name, exact: true });
const selected = (page: Page) => page.evaluate(() => document.getSelection()?.toString());
const url = (page: Page) => page.getByRole('textbox', { name: 'Link URL' });
const tone = (page: Page, name: string) => page.getByRole('menuitemradio', { name, exact: true });
const sentence = 'Its checkout took nine steps.';
const marked =
  'Next come **faster** ==search==, *saved* :color[carts]{tone="blue"}, ~~gift wrap~~, a `size` filter and [store hours](https://example.com).';

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

async function linkForm(page: Page) {
  await expect(toolbar(page)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
}

async function placement(page: Page) {
  await frame(page);
  const bar = await toolbar(page).boundingBox();
  const range = await page.evaluate(() => {
    const { top, bottom } = document.getSelection()?.getRangeAt(0).getBoundingClientRect() ?? {};
    return { top: top ?? 0, bottom: bottom ?? 0, width: document.documentElement.clientWidth };
  });
  if (bar === null) throw new Error('the toolbar has no box');
  expect(bar.x).toBeGreaterThanOrEqual(0);
  expect(bar.x + bar.width).toBeLessThanOrEqual(range.width);
  return bar.y + bar.height <= range.top ? 'above' : bar.y >= range.bottom ? 'below' : 'over';
}

for (const width of [1280, 390]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the toolbar shows by a selection that takes marks, after the pointer is up', async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await open(page);
      const box = await fields(page).nth(2).boundingBox();
      if (box === null) throw new Error('the field has no box');
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
      await frame(page);
      await expect(toolbar(page)).toBeHidden();
      await page.mouse.up();
      await expect(toolbar(page)).toBeVisible();
      expect(await placement(page)).toBe('above');
      await page.keyboard.press('ArrowRight');
      await expect(toolbar(page)).toBeHidden();
      for (const [from, to] of [
        [0, 8],
        [43, 48],
      ] as const) {
        await select(page, 1, from, to);
        await expect(toolbar(page)).toBeVisible();
        expect(await placement(page)).toBe('above');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await expect(toolbar(page).getByRole('button')).toHaveCount(8);
        for (const button of await toolbar(page).getByRole('button').all()) {
          const size = await button.boundingBox();
          expect(Math.min(size?.width ?? 0, size?.height ?? 0)).toBeGreaterThanOrEqual(24);
        }
      }
      for (const [from, to] of [[1, 2]] as const) {
        const [a, b] = await Promise.all([
          fields(page).nth(from).boundingBox(),
          fields(page).nth(to).boundingBox(),
        ]);
        if (a === null || b === null) throw new Error('the fields have no box');
        await page.mouse.move(a.x + 1, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 4 });
        await page.mouse.up();
        await frame(page);
        await expect(toolbar(page)).toBeHidden();
      }
      await select(page, 5, 0, 3);
      await expect(toolbar(page)).toBeVisible();
      // Every drag and a WebKit script selection clamp to the field they start in.
      const spans = await page.evaluate(() => {
        const [value, label] = [
          ...document.querySelectorAll('[data-ff-editor] [data-field]'),
        ].slice(5);
        if (value === undefined || label === undefined) throw new Error('the metric has no fields');
        const selection = document.getSelection();
        selection?.setBaseAndExtent(value, 0, label, label.childNodes.length);
        return selection !== null && !value.contains(selection.getRangeAt(0).endContainer);
      });
      await frame(page);
      await expect(toolbar(page)).toBeVisible({ visible: !spans });
      await select(page, 0, 0, 5);
      await expect(toolbar(page)).toBeVisible();
      await page.mouse.click(5, 5);
      await expect(toolbar(page)).toBeHidden();
      expect(errors).toEqual([]);
      await fields(page)
        .nth(2)
        .evaluate((field) => {
          document.body.style.paddingBottom = '100vh';
          field.scrollIntoView({ block: 'start' });
        });
      await select(page, 2, 4, 12);
      await expect(toolbar(page)).toBeVisible();
      expect(await placement(page)).toBe('below');
      await select(page, 2, 4, 4);
      await expect(toolbar(page)).toBeHidden();
    });

    test('showing, moving and hiding the toolbar render no block; a mark renders one', async ({
      page,
    }) => {
      await open(page);
      const field = fields(page).nth(2);
      const id = await blockOf(field).getAttribute('data-block-id');
      const commits = page.getByTestId('commits');
      await commits.evaluate((output) => output.replaceChildren());
      await select(page, 2, 4, 8);
      await expect(toolbar(page)).toBeVisible();
      await page.keyboard.press('Shift+ArrowRight');
      await page.evaluate(() => {
        document.body.style.paddingBottom = '100vh';
        window.scrollBy(0, 40);
      });
      await frame(page);
      await page.keyboard.press('ArrowRight');
      await expect(toolbar(page)).toBeHidden();
      await frame(page);
      expect(await commits.textContent()).toBe('');
      await select(page, 2, 4, 12);
      await tool(page, 'Bold').click();
      await expect(field.locator('strong')).toHaveText('checkout');
      await frame(page);
      expect(new Set((await commits.textContent())?.trim().split(/\s+/))).toEqual(new Set([id]));
    });

    test('each button toggles its mark in place and Mod+S saves it as markdown', async ({
      page,
    }) => {
      await open(page);
      for (const [name, mark] of [
        ['Bold', 'strong'],
        ['Italic', 'em'],
        ['Strikethrough', 's'],
        ['Highlight', 'mark'],
        ['Code', 'code'],
        ['Link', '[data-ff-link]'],
      ] as const) {
        await fields(page).nth(8).locator(mark).dblclick();
        await expect(tool(page, name)).toHaveAttribute('aria-pressed', 'true');
        await expect(toolbar(page).locator('[aria-pressed="true"]')).toHaveCount(1);
        await page.keyboard.press('ArrowRight');
        await expect(toolbar(page)).toBeHidden();
      }
      await page.keyboard.press('ControlOrMeta+s');
      await expect.poll(() => page.getByTestId('saved').textContent()).toContain(`\n${marked}\n`);
      const field = fields(page).nth(2);
      for (const [name, tag, from, to] of [
        ['Bold', 'strong', 0, 3],
        ['Italic', 'em', 4, 12],
        ['Strikethrough', 's', 13, 17],
        ['Code', 'code', 18, 22],
      ] as const) {
        await select(page, 2, from, to);
        await expect(toolbar(page).locator('[aria-pressed="true"]')).toHaveCount(0);
        await tool(page, name).click();
        const word = sentence.slice(from, to);
        await expect(field.locator(tag)).toHaveText(word);
        await expect(field).toBeFocused();
        expect(await selected(page)).toBe(word);
        await expect(tool(page, name)).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('ControlOrMeta+z');
        await expect(field.locator(tag)).toHaveCount(0);
        await expect(tool(page, name)).toHaveAttribute('aria-pressed', 'false');
        await tool(page, name).click();
        await expect(toolbar(page).locator('[aria-pressed="true"]')).toHaveCount(1);
      }
      await select(page, 2, 23, 28);
      await linkForm(page);
      await url(page).fill('https://example.com');
      await page.keyboard.press('Enter');
      await expect(field.locator('[data-ff-link]')).toHaveText('steps');
      await expect(tool(page, 'Link')).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('ControlOrMeta+s');
      await expect(page.getByTestId('saved')).toContainText(
        '**Its** *checkout* ~~took~~ `nine` [steps](https://example.com).',
      );
    });

    test('a metric value and label take marks that Mod+S saves inside the attributes', async ({
      page,
    }) => {
      await open(page);
      await select(page, 5, 0, 7);
      await expect(toolbar(page)).toBeVisible();
      await tool(page, 'Bold').click();
      await expect(fields(page).nth(5).locator('strong')).toHaveText('3 steps');
      await select(page, 6, 0, 8);
      await expect(toolbar(page)).toBeVisible();
      await tool(page, 'Text colour').click();
      await tone(page, 'Blue').click();
      await expect(fields(page).nth(6).locator('[data-ff-color="blue"]')).toHaveText('Checkout');
      await page.keyboard.press('ControlOrMeta+s');
      await expect(page.getByTestId('saved')).toContainText(
        '::metric{value="**3 steps**" label=":color[Checkout]{tone=&#x22;blue&#x22;} *length*"}',
      );
    });

    test('Highlight marks the selection in place, Mod+Shift+H removes it and undo restores it', async ({
      page,
    }) => {
      await open(page);
      const field = fields(page).nth(2);
      const id = await blockOf(field).getAttribute('data-block-id');
      const commits = page.getByTestId('commits');
      await select(page, 2, 4, 12);
      await expect(toolbar(page)).toBeVisible();
      await commits.evaluate((output) => output.replaceChildren());
      await tool(page, 'Highlight').click();
      await expect(field.locator('mark')).toHaveText('checkout');
      await expect(field).toBeFocused();
      expect(await selected(page)).toBe('checkout');
      await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'true');
      await frame(page);
      expect(new Set((await commits.textContent())?.trim().split(/\s+/))).toEqual(new Set([id]));
      await page.keyboard.press('ControlOrMeta+Shift+h');
      await expect(field.locator('mark')).toHaveCount(0);
      await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'false');
      await page.keyboard.press('ControlOrMeta+z');
      await expect(field.locator('mark')).toHaveText('checkout');
      await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'true');
    });

    test('the colour menu colours the selection, follows it and clears it', async ({ page }) => {
      await open(page);
      const field = fields(page).nth(2);
      const menu = page.getByRole('menu', { name: 'Text colour' });
      const checked = menu.locator('[aria-checked="true"]');
      const blue = field.locator('[data-ff-color="blue"]');
      await select(page, 0, 26, 36);
      for (const name of ['Change case', 'Text colour']) {
        await tool(page, name).click();
        await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
        const box = await page.getByRole('menu', { name }).boundingBox();
        if (box === null) throw new Error('the menu has no box');
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await select(page, 2, 4, 12);
      await tool(page, 'Text colour').click();
      await expect(checked).toHaveCount(0);
      await tone(page, 'Blue').click();
      await expect(blue).toHaveText('checkout');
      await expect(field).toBeFocused();
      expect(await selected(page)).toBe('checkout');
      const [shown, token] = await blue.evaluate((span) => {
        const probe = document.body.appendChild(document.createElement('span'));
        probe.style.color = 'var(--ff-color-blue)';
        const both = [getComputedStyle(span).color, getComputedStyle(probe).color];
        probe.remove();
        return both;
      });
      expect(shown).toBe(token);
      await page.keyboard.press('ControlOrMeta+s');
      await expect(page.getByTestId('saved')).toContainText(
        'Its :color[checkout]{tone="blue"} took nine steps.',
      );
      await tool(page, 'Text colour').click();
      await expect(tone(page, 'Blue')).toHaveAttribute('aria-checked', 'true');
      await expect(checked).toHaveCount(1);
      await select(page, 2, 0, 12);
      await expect(menu).toBeHidden();
      await tool(page, 'Text colour').click();
      await expect(checked).toHaveCount(0);
      await tone(page, 'Red').click();
      await expect(field.locator('[data-ff-color="red"]')).toHaveText('Its checkout');
      await tool(page, 'Text colour').click();
      await expect(tone(page, 'Red')).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('ControlOrMeta+z');
      await expect(blue).toHaveText('checkout');
      await expect(checked).toHaveCount(0);
      await select(page, 2, 4, 12);
      await tool(page, 'Text colour').click();
      await tone(page, 'Default').click();
      await expect(field.locator('[data-ff-color]')).toHaveCount(0);
    });

    test('a case keeps the marks and undoes in one step', async ({ page }) => {
      await open(page);
      const field = fields(page).nth(2);
      await select(page, 2, 4, 12);
      await tool(page, 'Bold').click();
      for (const [name, text] of [
        ['UPPERCASE', 'ITS CHECKOUT'],
        ['lowercase', 'its checkout'],
        ['Capitalize Words', 'Its Checkout'],
      ] as const) {
        await select(page, 2, 0, 12);
        await tool(page, 'Change case').click();
        await page.getByRole('menuitem', { name, exact: true }).click();
        await expect(field).toHaveText(`${text}${sentence.slice(12)}`);
        await expect(field.locator('strong')).toHaveText(text.slice(4));
        await page.keyboard.press('ControlOrMeta+z');
        await expect(field).toHaveText(sentence);
        await expect(field.locator('strong')).toHaveText('checkout');
      }
    });

    test('the link form refuses unsafe links, removes one and returns to the field', async ({
      page,
    }) => {
      await open(page);
      const field = fields(page).nth(2);
      const commits = page.getByTestId('commits');
      await select(page, 2, 23, 28);
      await linkForm(page);
      await expect(url(page)).toHaveValue('');
      await field.click();
      await select(page, 2, 23, 28);
      await tool(page, 'Link').click();
      await url(page).click();
      await expect(url(page)).toBeFocused();
      await commits.evaluate((output) => output.replaceChildren());
      for (const href of ['javascript:alert(1)', 'data:text/html,x', '//evil.example']) {
        await url(page).fill(href);
        await page.keyboard.press('Enter');
        await expect(url(page)).toHaveAttribute('aria-invalid', 'true');
        await expect(toolbar(page)).toContainText('Only https:// and mailto: links');
      }
      await frame(page);
      expect(await commits.textContent()).toBe('');
      await url(page).clear();
      await url(page).pressSequentially('https://example.com');
      await page.keyboard.press('Enter');
      await expect(field.locator('[data-ff-link]')).toHaveText('steps');
      await expect(field).toBeFocused();
      await linkForm(page);
      await expect(url(page)).toHaveValue('https://example.com');
      await page.keyboard.press('Escape');
      await expect(url(page)).toBeHidden();
      await expect(field).toBeFocused();
      expect(await selected(page)).toBe('steps');
      await linkForm(page);
      await tool(page, 'Remove link').click();
      await expect(field.locator('[data-ff-link]')).toHaveCount(0);
      await expect(field).toHaveText(sentence);
    });

    test('Alt+F10 enters the toolbar, arrows move, Escape returns to the selection', async ({
      page,
    }) => {
      await open(page);
      const field = fields(page).nth(2);
      await select(page, 2, 4, 12);
      await expect(toolbar(page)).toBeVisible();
      await page.keyboard.press('Alt+F10');
      for (const [key, name] of [
        ['', 'Bold'],
        ['ArrowRight', 'Italic'],
        ['ArrowRight', 'Strikethrough'],
        ['ArrowRight', 'Highlight'],
        ['ArrowRight', 'Text colour'],
        ['ArrowRight', 'Code'],
        ['Home', 'Bold'],
        ['ArrowLeft', 'Change case'],
        ['ArrowRight', 'Bold'],
        ['End', 'Change case'],
        ['Home', 'Bold'],
      ] as const) {
        if (key !== '') await page.keyboard.press(key);
        await expect(tool(page, name)).toBeFocused();
      }
      await page.keyboard.press('Enter');
      await expect(field.locator('strong')).toHaveText('checkout');
      await expect(tool(page, 'Bold')).toBeFocused();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menuitem', { name: 'UPPERCASE' })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitem', { name: 'lowercase' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(tool(page, 'Change case')).toBeFocused();
      for (const key of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'Enter'])
        await page.keyboard.press(key);
      await expect(tone(page, 'Default')).toBeFocused();
      for (const [key, name] of [
        ['ArrowUp', 'Purple'],
        ['Home', 'Default'],
        ['End', 'Purple'],
        ['ArrowDown', 'Default'],
        ['ArrowDown', 'Red'],
        ['ArrowDown', 'Orange'],
        ['ArrowDown', 'Green'],
      ] as const) {
        await page.keyboard.press(key);
        await expect(tone(page, name)).toBeFocused();
      }
      await page.keyboard.press('Enter');
      await expect(field.locator('[data-ff-color="green"]')).toHaveText('checkout');
      await expect(field).toBeFocused();
      expect(await selected(page)).toBe('checkout');
      await expect(toolbar(page)).toBeVisible();
      await page.keyboard.press('Alt+F10');
      await expect(tool(page, 'Text colour')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(tone(page, 'Green')).toBeFocused();
      for (const control of [
        ...(await toolbar(page).getByRole('button').all()),
        ...(await toolbar(page).getByRole('menuitemradio').all()),
      ]) {
        await expect(control).toHaveAccessibleName(/\S/);
      }
      await page.keyboard.press('Escape');
      await expect(tool(page, 'Text colour')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(field).toBeFocused();
      expect(await selected(page)).toBe('checkout');
    });
  });
}
