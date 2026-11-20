import { expect, type Locator, type Page, test } from '@playwright/test';
import { frame } from '../frame.ts';

const fields = (page: Page) => page.locator('[data-ff-editor] [data-field]');
const handle = (page: Page) => page.locator('[data-ff-grip]');
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
  const id = await block.getAttribute('data-block-id');
  await expect(page.locator('[data-ff-chrome]')).toHaveAttribute('data-ff-target', id ?? '');
  const box = await handle(page).boundingBox();
  if (box === null) throw new Error('the handle has no box');
  const press = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  return press;
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
  await expect(calloutFields(page, 0).nth(1)).toBeFocused();
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
  await page.keyboard.press('ControlOrMeta+z');
  await expect(calloutFields(page, 1)).toHaveText([texts[7] ?? '']);
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

test('a grip click opens nothing; the dots button opens the menu', async ({ page }) => {
  await open(page);
  const remove = page.getByRole('menuitem', { name: 'Delete', exact: true });
  await field(page, 1).hover();
  await handle(page).click();
  await frame(page);
  await expect(remove).toBeHidden();
  await page.locator('[data-ff-handle]').click();
  await expect(remove).toBeVisible();
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

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element has no box');
  return box;
}

async function differing(shots: readonly string[]) {
  const [a = [], b = []] = await Promise.all(
    shots.map(async (shot) => {
      const bytes = Uint8Array.from(atob(shot), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
      context?.drawImage(bitmap, 0, 0);
      return [...(context?.getImageData(0, 0, bitmap.width, bitmap.height).data ?? [])];
    }),
  );
  if (a.length !== b.length) return 1;
  const off = a.filter((value, at) => at % 4 < 3 && Math.abs(value - (b[at] ?? 0)) > 4);
  return off.length / (a.length * 0.75);
}

const spans = (page: Page, block: Locator) =>
  expect
    .poll(async () => {
      const [drop, box] = await Promise.all([boxOf(line(page)), boxOf(block)]);
      return Math.max(Math.abs(drop.x - box.x), Math.abs(drop.width - box.width));
    })
    .toBeLessThanOrEqual(1);

for (const width of [1280, 390]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the line shows in place, glides 100 ms, and a drop lands at once', async ({ page }) => {
      await open(page);
      const shown = await line(page).evaluateHandle((node) => {
        const animated: number[] = [];
        let hidden = true;
        const tick = () =>
          requestAnimationFrame(() => {
            setTimeout(() => {
              const now = node.hasAttribute('hidden');
              if (hidden && !now) animated.push(node.getAnimations().length);
              hidden = now;
            });
            tick();
          });
        tick();
        return animated;
      });
      for (const [from, over, to] of [
        [1, 3, 3],
        [4, 0, 1],
      ] as const) {
        const text = await fields(page).nth(from).textContent();
        const id = await field(page, from).getAttribute('data-block-id');
        await grab(page, field(page, from));
        await aim(page, field(page, over), 'before');
        await expect(line(page)).toBeVisible();
        const run = await line(page).evaluateHandle((node) => ({
          duration: new Promise<string>((resolve) => {
            const read = () => resolve(getComputedStyle(node).transitionDuration);
            node.addEventListener('transitionrun', read, { once: true });
          }),
        }));
        await aim(page, field(page, over), 'after');
        expect(await run.evaluate(({ duration }) => duration)).toBe('0.1s');
        const drop = await page.evaluateHandle((id) => {
          const next = new Promise((resolve) => {
            const read = () => {
              const block = document.querySelector(`[data-block-id="${id}"]`);
              resolve({
                ghosts: document.querySelectorAll('[data-ff-ghost]').length,
                animations: block?.getAnimations().length,
                top: block?.getBoundingClientRect().top,
              });
            };
            const up = () => requestAnimationFrame(() => setTimeout(read));
            addEventListener('pointerup', up, { capture: true, once: true });
          });
          return { next };
        }, id);
        await page.mouse.up();
        const seen = await drop.evaluate(({ next }) => next);
        await expect(fields(page).nth(to)).toHaveText(text ?? '');
        const settled = await boxOf(page.locator(`[data-block-id="${id}"]`));
        expect(seen).toEqual({ ghosts: 0, animations: 0, top: expect.closeTo(settled.y, 1) });
        await frame(page);
        expect([...new Set(await shown.evaluate((animated) => animated.splice(0)))]).toEqual([0]);
      }
    });

    test('the ghost follows the pointer at 0.4 under the line; Escape cancels', async ({
      page,
    }) => {
      await open(page);
      const texts = await fields(page).allTextContents();
      const callout = blockOf(callouts(page).first());
      for (const [source, over, at] of [
        [field(page, 1), field(page, 2), undefined],
        [field(page, 0), field(page, 1), undefined],
        [field(page, 5), callout, undefined],
        [callout, field(page, 4), { x: 8, y: 2 }],
      ] as const) {
        const press = await grab(page, source, at);
        await aim(page, over, 'after');
        await expect(line(page)).toBeVisible();
        const travel = (await boxOf(over)).x + 10 - press.x;
        const seen = await page.evaluate(async () => {
          const [copy, dimmed, drop] = ['[data-ff-ghost]', '[data-dragging]', '[data-ff-drop]'].map(
            (selector) => document.querySelector<HTMLElement>(selector),
          );
          if (!copy || !dimmed || !drop) throw new Error('no drag in progress');
          await Promise.all(drop.getAnimations().map((each) => each.finished));
          const lineTop = (block: HTMLElement) => {
            const text = document
              .createTreeWalker(block, NodeFilter.SHOW_TEXT, (node) =>
                node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
              )
              .nextNode();
            const range = document.createRange();
            range.selectNodeContents(text ?? block);
            const top = range.getClientRects()[0]?.top ?? Number.NaN;
            return top - block.getBoundingClientRect().top;
          };
          const mid = drop.getBoundingClientRect();
          const hit = (on: boolean) => {
            copy.inert = !on;
            for (const each of [copy, drop]) each.style.pointerEvents = on ? 'auto' : '';
          };
          hit(true);
          const stack = document.elementsFromPoint(mid.x + mid.width / 2, mid.y + mid.height / 2);
          hit(false);
          const { scrollWidth, clientWidth } = document.documentElement;
          return {
            travel: copy.getBoundingClientRect().left - dimmed.getBoundingClientRect().left,
            lineTop: lineTop(copy) - lineTop(dimmed),
            overflow: scrollWidth - clientWidth,
            opacity: getComputedStyle(copy).opacity,
            lineOver: stack[0] === drop && copy.contains(stack[1] ?? null),
          };
        });
        expect(seen).toEqual({
          travel: expect.closeTo(travel, 0),
          lineTop: expect.closeTo(0, 0),
          overflow: 0,
          opacity: '0.4',
          lineOver: true,
        });
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect(ghost(page)).toHaveCount(0);
        await expect(line(page)).toBeHidden();
        await expect(fields(page)).toHaveText(texts);
      }
    });

    test('the ghost is drawn like its block, and a drag renders nothing', async ({ page }) => {
      await open(page);
      const commits = page.getByTestId('commits');
      await commits.evaluate((output) => output.replaceChildren());
      const shot = async (locator: Locator) =>
        (await page.screenshot({ clip: await boxOf(locator) })).toString('base64');
      for (const source of [
        field(page, 1),
        field(page, 0),
        field(page, 5),
        blockOf(calloutFields(page, 0)),
      ]) {
        // Chromium may draw LCD text on one and not the other; a filter turns it off on both.
        await source.evaluate((node) => node.style.setProperty('filter', 'opacity(0.99)'));
        const block = await shot(source);
        await source.evaluate((node) => node.style.removeProperty('filter'));
        const press = await grab(page, source);
        await page.mouse.move(press.x, press.y + 12);
        await expect(ghost(page)).toHaveCount(1);
        await page.evaluate(() => {
          const copy = document.querySelector<HTMLElement>('[data-ff-ghost]')?.style;
          copy?.setProperty('opacity', '1');
          copy?.setProperty('filter', 'opacity(0.99)');
          document.querySelector<HTMLElement>('[data-ff-drop]')?.setAttribute('hidden', '');
        });
        expect(await page.evaluate(differing, [block, await shot(ghost(page))])).toBeLessThan(0.01);
        await page.keyboard.press('Escape');
        await page.mouse.up();
      }
      await frame(page);
      expect(await commits.textContent()).toBe('');
    });

    test('a drop past the blocks, in a padding or outside lands at the aim', async ({ page }) => {
      await open(page);
      await page.locator('[data-ff-editor]').evaluate((root) => {
        root.style.paddingBlock = '60px';
      });
      const texts = await fields(page).allTextContents();
      const callout = blockOf(callouts(page).first());
      const press = await grab(page, blockOf(calloutFields(page, 0)));
      await page.mouse.move(press.x, press.y + 6);
      await spans(page, callout);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      const aside = await boxOf(callouts(page).first());
      await grab(page, field(page, 1));
      await page.mouse.move(aside.x + 8, aside.y + aside.height - 2, { steps: 5 });
      await spans(page, blockOf(calloutFields(page, 0)));
      await page.mouse.up();
      await expect(calloutFields(page, 0)).toHaveText([texts[7] ?? '', texts[1] ?? '']);
      const box = await boxOf(callout);
      await grab(page, field(page, 1));
      await page.mouse.move(box.x + 8, box.y + box.height - 6, { steps: 5 });
      await spans(page, callout);
      await page.mouse.move(box.x + 8, box.y + box.height + 40, { steps: 5 });
      await spans(page, callout);
      await page.mouse.up();
      await expect(fields(page).last()).toHaveText(texts[2] ?? '');
      const first = await boxOf(field(page, 0));
      await grab(page, field(page, 1));
      await page.mouse.move(first.x + 10, first.y - 40, { steps: 5 });
      await spans(page, field(page, 0));
      await page.mouse.up();
      await expect(fields(page).first()).toHaveText(texts[3] ?? '');
      await grab(page, field(page, 2));
      const y = await aim(page, field(page, 0), 'before');
      await page.mouse.move(width - 2, y, { steps: 5 });
      await spans(page, field(page, 0));
      await page.mouse.up();
      await expect(fields(page).first()).toHaveText(texts[4] ?? '');
    });
  });
}
