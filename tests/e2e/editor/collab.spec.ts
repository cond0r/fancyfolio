import { test as base, expect, type Locator, type Page } from '@playwright/test';
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
  'Next come faster search, saved carts, gift wrap, a size filter and store hours.',
];

const fields = (page: Page) => page.locator('[data-ff-editor] [data-field]');
const placeholder = (page: Page) => page.locator('[data-ff-editor] [data-ff-placeholder]');
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Text formatting' });
const chrome = (page: Page) => page.locator('[data-ff-chrome]');
const peer = (page: Page) => page.locator('[data-ff-presence] [data-ff-peer]');
const present = (page: Page) => page.locator('[data-ff-editor] [data-block-id][data-present]');
const blockOf = (inner: Locator) => inner.locator('xpath=ancestor::*[@data-block-id][1]');

type Peers = {
  readonly a: Page;
  readonly b: Page;
  readonly violations: readonly string[];
  holdB(): () => void;
};

const test = base.extend<{ peers: Peers }>({
  peers: async ({ browser, baseURL }, use) => {
    const room = crypto.randomUUID();
    const violations: string[] = [];
    let held: (() => void)[] | undefined;
    const contexts = [await browser.newContext({ baseURL }), await browser.newContext({ baseURL })];
    const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
    if (a === undefined || b === undefined) throw new Error('the peers have no pages');
    await b.routeWebSocket(/:1153\//, (page) => {
      const server = page.connectToServer();
      server.onMessage((message) => {
        if (held === undefined) page.send(message);
        else held.push(() => page.send(message));
      });
    });
    for (const page of [a, b]) {
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) =>
          console.error(`CSP ${event.violatedDirective} ${event.blockedURI}`),
        );
      });
      page.on('console', (message) => {
        if (message.text().startsWith('CSP ')) violations.push(message.text());
      });
      await page.goto(`/playground?room=${room}`);
      await expect(fields(page)).toHaveText(body);
    }
    const holdB = () => {
      held = [];
      return () => {
        const queued = held ?? [];
        held = undefined;
        for (const send of queued) send();
      };
    };
    await use({ a, b, violations, holdB });
    await Promise.all(contexts.map((context) => context.close()));
  },
});

async function caretAt(page: Page, index: number, offset: number) {
  await fields(page)
    .nth(index)
    .click({ position: { x: 1, y: 4 } });
  await page.keyboard.press('Home');
  for (let step = 0; step < offset; step += 1) await page.keyboard.press('ArrowRight');
}

async function select(page: Page, index: number, from: number, to: number) {
  await caretAt(page, index, from);
  for (let step = from; step < to; step += 1) await page.keyboard.press('Shift+ArrowRight');
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element has no box');
  return box;
}

async function markedAtCaret(author: Page, viewer: Page) {
  const caret = await author.evaluate(() => {
    const rect = document.getSelection()?.getRangeAt(0).getClientRects()[0];
    if (rect === undefined) throw new Error('the author has no caret');
    return { x: rect.x, y: rect.y };
  });
  await expect
    .poll(async () => {
      const box = await peer(viewer).boundingBox();
      return box === null
        ? Infinity
        : Math.max(Math.abs(box.x - caret.x), Math.abs(box.y - caret.y));
    })
    .toBeLessThanOrEqual(2);
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

test('typing in one browser appears in the other with no CSP violation', async ({ peers }) => {
  const { a, b } = peers;
  await caretAt(a, 2, body[2]?.length ?? 0);
  await a.keyboard.type(' Now three.');
  await expect(fields(b).nth(2)).toHaveText('Its checkout took nine steps. Now three.');
  expect(peers.violations).toEqual([]);
});

test('a removal in A and typing in B converge; A undoes only its removal', async ({
  peers: { a, b },
}) => {
  await caretAt(b, 4, body[4]?.length ?? 0);
  await caretAt(a, 2, 0);
  await a.mouse.move(5, 5);
  await a.keyboard.press('ControlOrMeta+/');
  await a.keyboard.press('End');
  await a.keyboard.press('Enter');
  await b.keyboard.type(' Kept.');
  const typed = body.map((text, index) => (index === 4 ? `${text} Kept.` : text));
  for (const page of [a, b]) {
    await expect(fields(page)).toHaveText(typed.filter((_text, index) => index !== 2));
  }
  await a.keyboard.press('ControlOrMeta+z');
  for (const page of [a, b]) await expect(fields(page)).toHaveText(typed);
});

test('remote typing before the caret leaves it after the same character', async ({
  peers: { a, b },
}) => {
  await caretAt(b, 2, 3);
  await caretAt(a, 2, 0);
  await a.keyboard.type('AB');
  await expect(fields(b).nth(2)).toHaveText('ABIts checkout took nine steps.');
  await b.keyboard.type('X');
  for (const page of [a, b]) {
    await expect(fields(page).nth(2)).toHaveText('ABItsX checkout took nine steps.');
  }
});

test('marks from A reach B; only the author undoes them', async ({ peers: { a, b } }) => {
  const field = (page: Page) => fields(page).nth(2);
  await select(a, 2, 4, 12);
  await a.keyboard.press('ControlOrMeta+b');
  await select(a, 2, 18, 22);
  await toolbar(a).getByRole('button', { name: 'Text colour', exact: true }).click();
  await a.getByRole('menuitemradio', { name: 'Blue', exact: true }).click();
  await expect(field(a)).toBeFocused();
  const marked = async (page: Page) => {
    await expect(field(page).locator('strong')).toHaveText('checkout');
    await expect(field(page).locator('[data-ff-color="blue"]')).toHaveText('nine');
  };
  for (const page of [a, b]) await marked(page);
  await caretAt(b, 4, 0);
  await b.keyboard.press('ControlOrMeta+z');
  for (const page of [a, b]) await marked(page);
  await a.keyboard.press('ControlOrMeta+z');
  for (const page of [a, b]) {
    await expect(field(page).locator('[data-ff-color]')).toHaveCount(0);
    await expect(field(page).locator('strong')).toHaveText('checkout');
  }
});

test('an emptied room shows the placeholder; the first character makes one paragraph', async ({
  peers: { a, b, holdB },
}) => {
  const release = holdB();
  await dragAcross(a, 0, 3);
  await a.keyboard.press('Backspace');
  await expect(fields(a)).toHaveText(body.slice(4));
  await dragAcross(b, 4, 8);
  await b.keyboard.press('Backspace');
  await expect(fields(b)).toHaveText(body.slice(0, 4));
  await expect(placeholder(a)).toHaveAccessibleName('Type something');
  release();
  await expect(placeholder(b)).toHaveAccessibleName('Type something');
  await placeholder(b).focus();
  await b.keyboard.type('X');
  for (const page of [a, b]) {
    await expect(fields(page)).toHaveText(['X']);
    await expect(page.locator('[data-ff-editor] [data-block-type="paragraph"]')).toHaveCount(1);
  }
});

test('B marks the block A edits at A caret, in bold and coloured text too', async ({
  peers: { a, b },
}) => {
  await select(a, 2, 4, 12);
  await a.keyboard.press('ControlOrMeta+b');
  await select(a, 2, 18, 22);
  await toolbar(a).getByRole('button', { name: 'Text colour', exact: true }).click();
  await a.getByRole('menuitemradio', { name: 'Blue', exact: true }).click();
  await expect(fields(b).nth(2).locator('[data-ff-color="blue"]')).toHaveText('nine');
  for (const offset of [8, 23]) {
    await caretAt(a, 2, offset);
    await markedAtCaret(a, b);
    await a.keyboard.type('xyz');
    await markedAtCaret(a, b);
  }
  await expect(fields(b).nth(2)).toHaveText('Its checxyzkout took nixyzne steps.');
  await expect(present(b)).toHaveCount(1);
  await expect(blockOf(fields(b).nth(2))).toHaveAttribute('data-present', '');
});

test('remote typing and presence keep B chrome hidden, its toolbar and its renders', async ({
  peers: { a, b },
}) => {
  await select(b, 4, 6, 11);
  await expect(toolbar(b)).toBeVisible();
  const line = await boxOf(fields(b).nth(4));
  await b.mouse.move(1278, line.y + line.height / 2);
  await expect(chrome(b)).not.toHaveAttribute('data-ff-target');
  await caretAt(a, 4, 0);
  await a.keyboard.type('So ');
  await expect(fields(b).nth(4)).toHaveText('So Three steps remained.');
  const commits = b.getByTestId('commits');
  await expect(commits).toContainText(
    (await blockOf(fields(b).nth(4)).getAttribute('data-block-id')) ?? '',
  );
  await frame(b);
  await commits.evaluate((node) => node.replaceChildren());
  for (let step = 0; step < 12; step += 1) await a.keyboard.press('ArrowRight');
  await markedAtCaret(a, b);
  await expect(chrome(b)).not.toHaveAttribute('data-ff-target');
  await expect(commits).toHaveText('');
  expect(await b.evaluate(() => document.getSelection()?.toString())).toBe('steps');
  const picked = await b.evaluate(() => {
    const rect = document.getSelection()?.getRangeAt(0).getBoundingClientRect();
    if (rect === undefined) throw new Error('B has no selection');
    return { left: rect.left, right: rect.right, top: rect.top };
  });
  await expect(toolbar(b)).toBeVisible();
  const bar = await boxOf(toolbar(b));
  expect(bar.x).toBeLessThanOrEqual(picked.left);
  expect(bar.x + bar.width).toBeGreaterThanOrEqual(picked.right);
  expect(bar.y + bar.height).toBeLessThanOrEqual(picked.top);
});

test('hover and the drop line on B pass through A marker to the block beneath', async ({
  peers: { a, b },
}) => {
  await caretAt(a, 4, 5);
  await markedAtCaret(a, b);
  const marker = await boxOf(peer(b));
  const over = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
  const beneath = blockOf(fields(b).nth(4));
  await b.mouse.move(over.x, over.y);
  await expect(chrome(b)).toHaveAttribute(
    'data-ff-target',
    (await beneath.getAttribute('data-block-id')) ?? '',
  );
  const moved = blockOf(fields(b).nth(0));
  await moved.hover();
  await expect(chrome(b)).toHaveAttribute(
    'data-ff-target',
    (await moved.getAttribute('data-block-id')) ?? '',
  );
  const grip = await boxOf(b.locator('[data-ff-grip]'));
  await b.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await b.mouse.down();
  await b.mouse.move(over.x, over.y, { steps: 5 });
  const target = await boxOf(beneath);
  await expect
    .poll(async () => {
      const drop = await b.locator('[data-ff-drop]').boundingBox();
      if (drop === null) return Infinity;
      const middle = drop.y + drop.height / 2;
      return Math.min(Math.abs(middle - target.y), Math.abs(middle - target.y - target.height));
    })
    .toBeLessThanOrEqual(2);
  await b.keyboard.press('Escape');
  await b.mouse.up();
});

test('closing B removes its marker on A', async ({ peers: { a, b } }) => {
  await caretAt(b, 2, 3);
  await markedAtCaret(b, a);
  await b.close();
  await expect(peer(a)).toHaveCount(0);
  await expect(present(a)).toHaveCount(0);
});
