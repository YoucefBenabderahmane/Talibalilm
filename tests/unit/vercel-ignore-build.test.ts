import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The Vercel "Ignored Build Step", tested against a real repository.
 *
 * The script decides whether a push deploys. Getting it wrong in the safe
 * direction costs a build; getting it wrong in the silent direction ships a
 * site that never changed, which is exactly the failure this repo has already
 * paid for once (an invalid cron failed every deploy while CI stayed green).
 * So the cases below are less "does the happy path work" and more "does every
 * uncertainty fall through to BUILD".
 *
 * It is exercised through bash because Vercel runs it with bash, and against a
 * scratch repo because the answer depends on git history — mocking the diff
 * would test the mock.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/vercel-ignore-build.sh', import.meta.url));
const SCRIPT_BODY = readFileSync(SCRIPT, 'utf8');

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** A scratch repo with one root commit that already carries the script. */
function makeRepo(): { dir: string; root: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'vercel-ignore-build-'));
  roots.push(dir);

  git(dir, 'init', '-q');

  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts', 'vercel-ignore-build.sh'), SCRIPT_BODY);

  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'root');
  const root = git(dir, 'rev-parse', 'HEAD').trim();

  return { dir, root };
}

function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

function run(dir: string, previousSha: string | undefined): { code: number; output: string } {
  const env = { ...process.env };
  if (previousSha === undefined) delete env.VERCEL_GIT_PREVIOUS_SHA;
  else env.VERCEL_GIT_PREVIOUS_SHA = previousSha;

  try {
    const output = execFileSync('bash', ['scripts/vercel-ignore-build.sh'], {
      cwd: dir,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string };
    return { code: failure.status ?? -1, output: failure.stdout ?? '' };
  }
}

describe('vercel-ignore-build.sh', () => {
  it('a) previous SHA empty: builds', () => {
    const { dir } = makeRepo();
    const result = run(dir, '');
    expect(result.code).toBe(1);
    expect(result.output).toContain('no reachable previous deployment');
  });

  it('b) previous SHA does not exist: builds', () => {
    const { dir } = makeRepo();
    const result = run(dir, '0123456789abcdef0123456789abcdef01234567');
    expect(result.code).toBe(1);
    expect(result.output).toContain('no reachable previous deployment');
  });

  it('c) only docs and SQL changed since the previous deployment: skips', () => {
    const { dir, root } = makeRepo();
    commit(
      dir,
      {
        'docs/note.md': '# note\n',
        'supabase/migrations/20990101000000_example.sql': 'select 1;\n',
      },
      'docs and SQL only',
    );
    const result = run(dir, root);
    expect(result.code).toBe(0);
    expect(result.output).toContain('skipping');
  });

  it('d) a change under src/: builds', () => {
    const { dir, root } = makeRepo();
    commit(dir, { 'src/a.ts': 'export const a = 1;\n' }, 'app change');
    const result = run(dir, root);
    expect(result.code).toBe(1);
    expect(result.output).toContain('building');
  });

  it('e) multi-commit trap: src first, README last, previous SHA before both: builds', () => {
    // Judged by HEAD^ alone this push looks docs-only and would never deploy
    // the src change. The script compares against the previous DEPLOYMENT.
    const { dir, root } = makeRepo();
    commit(dir, { 'src/a.ts': 'export const a = 1;\n' }, 'app change');
    commit(dir, { 'README.md': '# readme\n' }, 'docs on top');
    const result = run(dir, root);
    expect(result.code).toBe(1);
    expect(result.output).toContain('building');
  });

  it('f) a change to messages/fr.json: builds', () => {
    const { dir, root } = makeRepo();
    commit(dir, { 'messages/fr.json': '{}\n' }, 'messages change');
    const result = run(dir, root);
    expect(result.code).toBe(1);
    expect(result.output).toContain('building');
  });
});
