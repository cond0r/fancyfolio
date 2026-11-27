import { test as base, expect, type Page } from '@playwright/test';

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
    await b.routeWebSocket(/localhost:1153/, (page) => {
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
