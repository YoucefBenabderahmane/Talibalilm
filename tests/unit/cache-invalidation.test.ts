import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every action that writes a cached table must invalidate its cache.
 *
 * The public pages are served from `unstable_cache` readers in
 * `@/lib/data/courses`, `commerce` and `site`. A write that forgets the tag
 * does not fail loudly — it leaves the old rows on `/`, `/courses` and the
 * module pages until the daily backstop happens to pass, which is
 * indistinguishable from the save button being broken. This test makes that
 * mistake a red suite instead of a phone call from the office.
 *
 * It reads the action files as source, not as a mock. The write is detected
 * where it is written (`.from('<table>')` immediately followed by
 * insert/update/upsert/delete, or an `.rpc()` from the audit below), and the
 * invalidation is accepted either directly in the function or one level away
 * in a local helper — `revalidateCatalogue`, `refresh` and `refreshPublic`
 * are exactly that.
 *
 * Known boundary, documented in the Change 4 audit: the payment path
 * (`claim_pack` / `release_order_holds` / `expire_pending_orders`) writes
 * `packs.redeemed_count`, which no cached reader selects, and is called from
 * `lib/commerce/orders.ts` and the sweep route rather than from an action
 * file. Those RPC names stay in the map below so that a future call from an
 * action is caught.
 */

const ACTIONS_DIR = fileURLToPath(new URL('../../src/app/actions', import.meta.url));

/** Tables read through the cached readers, mapped to the tag that rebuilds them. */
const CACHED_TABLES: ReadonlyMap<string, string> = new Map([
  ['courses', 'CATALOGUE_TAG'], // listCourses / getCourse / relatedCourses
  ['modules', 'CATALOGUE_TAG'], // COURSE_SELECT embed
  ['lessons', 'CATALOGUE_TAG'], // COURSE_SELECT embed
  ['cursus', 'CATALOGUE_TAG'], // listCursus / readProducts join
  ['cursus_courses', 'CATALOGUE_TAG'], // getProgramme
  ['products', 'CATALOGUE_TAG'], // listProducts / coursePrices
  ['packs', 'CATALOGUE_TAG'], // listPacks
  ['pack_items', 'CATALOGUE_TAG'], // listPacks embed
  ['site_settings', 'SITE_SETTINGS_TAG'], // getSiteSettings
  ['events', 'EVENTS_TAG'], // listEvents
  ['reviews', 'REVIEWS_TAG'], // listReviews
]);

/**
 * RPCs from the audit that write a cached table. None is called from an action
 * today; the map exists so that adding one without a tag fails here.
 */
const CACHED_WRITE_RPCS: ReadonlyMap<string, string> = new Map([
  ['claim_pack', 'packs'],
  ['release_order_holds', 'packs'],
  ['expire_pending_orders', 'packs'],
]);

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);

interface Finding {
  function: string;
  line: number;
  table: string;
}

interface Invalidation {
  /** Tag constants passed to `revalidateTag(...)` in the function body. */
  tags: Set<string>;
  /** `revalidatePath('/', 'layout')` — refreshes every public page. */
  global: boolean;
}

interface Fn {
  name: string;
  line: number;
  invalidates: Invalidation;
  /** Local functions this one calls. */
  calls: Set<string>;
  writes: Finding[];
}

function isLocalFunctionCall(node: ts.Node): string | null {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return null;
  return node.expression.text;
}

/** The table of `.from('table')` when the receiver is exactly that call. */
function tableOfFromCall(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'from') return null;
  const [first] = node.arguments;
  return first && ts.isStringLiteralLike(first) ? first.text : null;
}

/**
 * `supabase.from('courses').update(...)` — the write call's receiver is the
 * `.from()` call. Walking outward from `.from()` would also catch
 * `.select(...)`, so the walk is done through the write call's `expression`.
 */
function detectWrites(node: ts.CallExpression): Finding | null {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;

  if (WRITE_METHODS.has(method)) {
    const table = tableOfFromCall(callee.expression);
    if (table && CACHED_TABLES.has(table)) {
      const { line } = ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getStart());
      return { function: '', line: line + 1, table };
    }
  }

  // .rpc('name') — only the audited write RPCs count.
  if (method === 'rpc') {
    const [first] = node.arguments;
    if (first && ts.isStringLiteralLike(first) && CACHED_WRITE_RPCS.has(first.text)) {
      const { line } = ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getStart());
      return { function: '', line: line + 1, table: CACHED_WRITE_RPCS.get(first.text)! };
    }
  }

  return null;
}

function collectInvalidation(node: ts.CallExpression, invalidation: Invalidation): void {
  const callee = node.expression;
  if (!ts.isIdentifier(callee)) return;

  if (callee.text === 'revalidateTag') {
    const [first] = node.arguments;
    if (first && ts.isIdentifier(first)) invalidation.tags.add(first.text);
    return;
  }

  if (callee.text === 'revalidatePath') {
    const [pathArg, typeArg] = node.arguments;
    if (
      pathArg &&
      ts.isStringLiteralLike(pathArg) &&
      pathArg.text === '/' &&
      typeArg &&
      ts.isStringLiteralLike(typeArg) &&
      typeArg.text === 'layout'
    ) {
      invalidation.global = true;
    }
  }
}

/** Does an invalidation cover a write to `table`? */
function covers(invalidation: Invalidation, table: string): boolean {
  if (invalidation.global) return true;
  const tag = CACHED_TABLES.get(table);
  return tag !== undefined && invalidation.tags.has(tag);
}

function parseFile(file: string): Fn[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  const functions: Fn[] = [];

  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;

    const { line } = ts.getLineAndCharacterOfPosition(source, statement.getStart());
    const fn: Fn = {
      name: statement.name.text,
      line: line + 1,
      invalidates: { tags: new Set(), global: false },
      calls: new Set(),
      writes: [],
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        collectInvalidation(node, fn.invalidates);
        const finding = detectWrites(node);
        if (finding) fn.writes.push({ ...finding, function: fn.name });
        const called = isLocalFunctionCall(node);
        if (called) fn.calls.add(called);
      }
      ts.forEachChild(node, visit);
    };
    visit(statement.body);

    functions.push(fn);
  }

  return functions;
}

function analyse(): Finding[] {
  const offenders: Finding[] = [];

  for (const file of readdirSync(ACTIONS_DIR).filter((f) => f.endsWith('.ts'))) {
    const full = path.join(ACTIONS_DIR, file);
    const functions = parseFile(full);
    const byName = new Map(functions.map((f) => [f.name, f]));

    for (const fn of functions) {
      if (fn.writes.length === 0) continue;

      // One level of local-helper resolution: an action that calls
      // `revalidateCatalogue()` / `refresh()` / `refreshPublic()` has done
      // what those helpers do, because they are in this same file.
      const invalidations: Invalidation[] = [fn.invalidates];
      for (const called of fn.calls) {
        const helper = byName.get(called);
        if (helper) invalidations.push(helper.invalidates);
      }

      for (const write of fn.writes) {
        if (invalidations.some((invalidation) => covers(invalidation, write.table))) continue;
        offenders.push({ ...write, function: `${file}:${write.function}` });
      }
    }
  }

  return offenders;
}

describe('cache invalidation coverage', () => {
  it('every action writing a cached table invalidates its cache', () => {
    const offenders = analyse();
    const report = offenders
      .map((o) => `${o.function} (line ${o.line}) writes "${o.table}" without a tag`)
      .join('\n');

    expect(offenders, report).toEqual([]);
  });
});
