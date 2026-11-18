import { expect, type Locator, type Page, test } from '@playwright/test';

const fields = (page: Page) => page.locator('[data-ff-editor] [data-field]');
const handle = (page: Page) => page.locator('[data-ff-handle]');
const line = (page: Page) => page.locator('[data-ff-drop]');
const dragging = (page: Page) => page.locator('[data-dragging]');
const ghost = (page: Page) => page.locator('[data-ff-ghost]');
const callouts = (page: Page) => page.locator('[data-ff-editor] aside');
const calloutFields = (page: Page, index: number) =>
  callouts(page).nth(index).locator('[data-field]');
const blockOf = (inner: Locator) => inner.locator('xpath=ancestor::*[@data-block-id][1]');
const field = (page: Page, index: number) => blockOf(fields(page).nth(index));

async function open(page: Page) {
  await page.goto('/playground');
  await expect(fields(page)).toHaveCount(8);
  await page.waitForLoadState('networkidle');
}

async function grab(page: Page, block: Locator, position?: { x: number; y: number }) {
  await block.hover({ position });
  const box = await handle(page).boundingBox();
  if (box === null) throw new Error('the handle has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

async function aim(page: Page, over: Locator, side: 'before' | 'after') {
  const box = await over.boundingBox();
  if (box === null) throw new Error('the drop target has no box');
  const y = box.y + box.height * (side === 'before' ? 0.25 : 0.75);
  await page.mouse.move(box.x + 10, y, { steps: 5 });
  return y;
}

async function drag(page: Page, block: Locator, over: Locator, side: 'before' | 'after') {
  await grab(page, block);
  await aim(page, over, side);
  await page.mouse.up();
}

async function insertCallout(page: Page, below: number) {
  await field(page, below).hover();
  await page.locator('[data-ff-insert]').click();
  await page.getByRole('menuitem', { name: 'Callout', exact: true }).click();
  await expect(callouts(page)).toHaveCount(2);
}

test('dragging block 3 above block 1 reorders it; one Ctrl+Z restores', async ({ page }) => {
  await open(page);
  const texts = await fields(page).allTextContents();
  await grab(page, field(page, 2));
  await aim(page, field(page, 0), 'before');
  await expect(line(page)).toHaveCount(1);
  await expect(line(page)).toBeVisible();
  await expect(field(page, 2)).toHaveAttribute('data-dragging');
  await page.mouse.up();
  const moved = [...texts];
  moved.unshift(...moved.splice(2, 1));
  await expect(fields(page)).toHaveText(moved);
  await expect(line(page)).toBeHidden();
  await expect(dragging(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(fields(page)).toHaveText(texts);
});

test('one line glides across targets while a ghost follows the pointer', async ({ page }) => {
  await open(page);
  await field(page, 0).hover();
  await expect(handle(page)).toHaveCSS('cursor', 'grab');
  await grab(page, field(page, 0));
  const offset = async (y: number) => ((await ghost(page).boundingBox())?.y ?? Number.NaN) - y;
  const start = await offset(await aim(page, field(page, 2), 'before'));
  await expect(line(page)).toBeVisible();
  await expect(handle(page)).toHaveCSS('cursor', 'grabbing');
  const watch = await line(page).evaluateHandle((node) => {
    const seen: boolean[] = [];
    new MutationObserver(() => seen.push(node.hasAttribute('hidden'))).observe(node, {
      attributes: true,
    });
    return { node, seen };
  });
  const transform = () => line(page).evaluate((node) => getComputedStyle(node).transform);
  for (const [over, side] of [
    [2, 'after'],
    [4, 'after'],
  ] as const) {
    const before = await transform();
    expect(await offset(await aim(page, field(page, over), side))).toBeCloseTo(start, 0);
    await expect.poll(transform).not.toBe(before);
  }
  expect(await watch.evaluate(({ node, seen }) => [node.isConnected, seen.includes(true)])).toEqual(
    [true, false],
  );
  await expect(line(page)).toHaveCount(1);
  await page.mouse.up();
  await expect(ghost(page)).toHaveCount(0);
  await expect(line(page)).toBeHidden();
});

test('a block drags into a callout, between callouts and out of one', async ({ page }) => {
  await open(page);
  const texts = await fields(page).allTextContents();
  const live = page.locator('[data-ff-live]');
  await drag(page, field(page, 1), field(page, 7), 'after');
  await expect(calloutFields(page, 0)).toHaveText([texts[7] ?? '', texts[1] ?? '']);
  await expect(live).toHaveText('Moved Text to 2 of 2 in Callout');
  await insertCallout(page, 3);
  const moved = blockOf(calloutFields(page, 1).nth(1));
  const id = await moved.getAttribute('data-block-id');
  await drag(page, moved, blockOf(calloutFields(page, 0)), 'before');
  await expect(page.locator(`[data-block-id="${id}"]`)).toHaveCount(1);
  await expect(calloutFields(page, 0)).toHaveText([texts[1] ?? '', '']);
  await expect(live).toHaveText('Moved Text to 1 of 2 in Callout');
  await drag(page, blockOf(calloutFields(page, 1)), field(page, 0), 'before');
  await expect(fields(page).first()).toHaveText(texts[7] ?? '');
  await expect(calloutFields(page, 1)).toHaveText(['']);
  await expect(live).toHaveText('Moved Text to 1 of 8');
});

test('a callout over another callout body shows no line and moves nothing', async ({ page }) => {
  await open(page);
  await insertCallout(page, 4);
  const texts = await fields(page).allTextContents();
  await grab(page, blockOf(callouts(page).first()), { x: 8, y: 2 });
  await aim(page, blockOf(calloutFields(page, 1)), 'before');
  await expect(dragging(page)).toHaveCount(1);
  await expect(line(page)).toBeHidden();
  await page.mouse.up();
  await expect(fields(page)).toHaveText(texts);
  await expect(callouts(page)).toHaveCount(2);
});

test('a handle click opens the menu; after a drag it stays shut', async ({ page }) => {
  await open(page);
  const texts = await fields(page).allTextContents();
  const remove = page.getByRole('menuitem', { name: 'Delete', exact: true });
  await field(page, 1).hover();
  await handle(page).click();
  await expect(remove).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(remove).toBeHidden();
  await drag(page, field(page, 1), field(page, 2), 'after');
  await expect(fields(page).nth(2)).toHaveText(texts[1] ?? '');
  await expect(remove).toBeHidden();
});

test('a pointercancel mid-drag hides the still line and moves nothing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const texts = await fields(page).allTextContents();
  await grab(page, field(page, 1));
  await aim(page, field(page, 3), 'after');
  await expect(line(page)).toBeVisible();
  await expect(line(page)).toHaveCSS('transition-duration', '0s');
  await expect(ghost(page)).toHaveCount(1);
  await handle(page).dispatchEvent('pointercancel');
  await expect(line(page)).toBeHidden();
  await expect(ghost(page)).toHaveCount(0);
  await expect(dragging(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(fields(page)).toHaveText(texts);
});
