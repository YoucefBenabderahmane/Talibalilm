import { expect, test } from '@playwright/test';

/**
 * The page must never be wider than the screen.
 *
 * The room's white strip taught this one: a long unbreakable word in the chat
 * gave the side panel a min-content wider than the viewport, the flex row
 * overflowed, and scrolling right showed the body behind the room. The check is
 * one number — `scrollWidth` against `innerWidth` — and it catches that whole
 * class of bug on every public page, at a phone width and a tablet width.
 */
const ROUTES = [
  '/',
  '/courses',
  '/courses/fiqh-al-ibadat',
  '/cursus/e2e-cursus-approfondi',
  '/contact',
  '/login',
  '/register',
  '/forgot-password',
];

const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 768, height: 1024 },
];

for (const route of ROUTES) {
  for (const viewport of VIEWPORTS) {
    test(`${route} fits a ${viewport.width}px screen`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(route);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `horizontal overflow on ${route} at ${viewport.width}px`).toBeLessThanOrEqual(1);
    });
  }
}
