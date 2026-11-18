import type { Page } from '@playwright/test';

export type Sample = { overs: number; translate: string; visible: boolean };

export async function frame(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

export async function sampler(page: Page, selector: string) {
  const log = await page.evaluateHandle((selector) => {
    const samples: Sample[] = [];
    const element = document.querySelector<HTMLElement>(selector);
    if (element === null) throw new Error(`nothing matches ${selector}`);
    let overs = 0;
    document.addEventListener('pointerover', () => (overs += 1), { capture: true });
    const tick = () =>
      requestAnimationFrame(() => {
        const seen = overs;
        setTimeout(() => {
          const { translate } = element.style;
          const visible = element.checkVisibility({ visibilityProperty: true });
          const opaque = getComputedStyle(element).opacity === '1';
          samples.push({ overs: seen, translate, visible: visible && opaque });
        });
        tick();
      });
    tick();
    return samples;
  }, selector);
  return async () => {
    await frame(page);
    await frame(page);
    return log.evaluate((samples) => samples.splice(0));
  };
}
