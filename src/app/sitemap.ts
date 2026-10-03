import type { MetadataRoute } from 'next';
import { listCourses } from '@/lib/data/courses';
import { listCursus } from '@/lib/data/commerce';

import { routing } from '@/i18n/routing';
import { siteUrl } from '@/lib/env';

/**
 * An hour, not every five minutes. A sitemap is a crawler's map, not a feed,
 * and rebuilding it twelve times an hour cost function CPU for a list that
 * changes when a module is published — which revalidates the tag anyway.
 */
export const revalidate = 3600;

/** Prefix for a locale — the default one is unprefixed, per the routing config. */
function prefix(locale: string): string {
  return locale === routing.defaultLocale ? '' : `/${locale}`;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];
  // Read once, not per locale. The catalogue is the database's now — the
  // fixtures this used to read listed six courses that mostly 404ed and none
  // of the real ones, which is worse than an empty sitemap.
  const [courses, cursusList] = await Promise.all([listCourses(), listCursus()]);

  for (const locale of routing.locales) {
    const p = prefix(locale);
    entries.push(
      { url: `${base}${p || '/'}`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
      { url: `${base}${p}/courses`, lastModified: now, changeFrequency: 'weekly', priority: 0.9 },
      { url: `${base}${p}/contact`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    );

    for (const course of courses) {
      entries.push({
        url: `${base}${p}/courses/${course.slug}`,
        lastModified: new Date(course.published_at),
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }

    // The cursus pages: one per published cursus, the programme a student
    // lands on after buying one.
    for (const cursus of cursusList) {
      entries.push({
        url: `${base}${p}/cursus/${cursus.slug}`,
        lastModified: now,
        changeFrequency: 'weekly',
        priority: 0.8,
      });
    }
  }

  return entries;
}
