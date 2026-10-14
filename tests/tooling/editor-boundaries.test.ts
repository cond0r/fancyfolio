import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const tempTrees: string[] = [];

afterAll(() => {
  for (const dir of tempTrees) rmSync(dir, { recursive: true, force: true });
});

function lintAt(path: string, source: string) {
  const tree = mkdtempSync(join(tmpdir(), 'ff-lint-'));
  tempTrees.push(tree);
  copyFileSync(join(root, 'biome.json'), join(tree, 'biome.json'));
  mkdirSync(dirname(join(tree, path)), { recursive: true });
  writeFileSync(join(tree, path), source);
  const result = spawnSync(
    join(root, 'node_modules', '.bin', 'biome'),
    ['lint', '--colors=off', '--vcs-use-ignore-file=false', path],
    { cwd: tree, encoding: 'utf8', timeout: 20_000 },
  );
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`biome stopped by signal ${result.signal}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const dialectModule = 'packages/editor/src/dialect.ts';

describe(`${dialectModule} imports no React, Jotai, DOM or workspace module`, () => {
  const message =
    'The dialect stays free of React, Jotai, the DOM, servers and workspace packages.';

  it('passes the parser packages it needs', () => {
    const result = lintAt(
      dialectModule,
      "import type { Root } from 'mdast';\nimport { directiveFromMarkdown } from 'mdast-util-directive';\nimport { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote';\nimport { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';\nimport { gfmTableFromMarkdown } from 'mdast-util-gfm-table';\nimport { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';\nimport { directive } from 'micromark-extension-directive';\nimport { gfmFootnote } from 'micromark-extension-gfm-footnote';\nimport { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';\nimport { gfmTable } from 'micromark-extension-gfm-table';\nimport { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';\nimport remarkParse from 'remark-parse';\nimport remarkStringify from 'remark-stringify';\nimport { unified } from 'unified';\n\nexport const used: unknown[] = [directiveFromMarkdown, gfmFootnoteFromMarkdown, gfmStrikethroughFromMarkdown, gfmTableFromMarkdown, gfmTaskListItemFromMarkdown, directive, gfmFootnote, gfmStrikethrough, gfmTable, gfmTaskListItem, remarkParse, remarkStringify, unified];\nexport type Tree = Root;\n",
    );
    expect(result.output).not.toContain('lint/');
    expect(result.status).toBe(0);
  });

  it.each([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    'jotai',
    'jotai/vanilla',
    '@fancyfolio/contracts',
    '@fancyfolio/editor/core',
    '@fancyfolio/db',
    'postgres',
    '../../../apps/web/lib/blocks.ts',
  ])('refuses %s', (specifier) => {
    const result = lintAt(
      dialectModule,
      `import * as banned from '${specifier}';\n\nexport const value = banned;\n`,
    );
    expect(result.output).toContain('lint/style/noRestrictedImports');
    expect(result.output).toContain(message);
    expect(result.status).not.toBe(0);
  });

  it.each(['window', 'document', 'navigator', 'DOMParser', 'Bun'])(
    'refuses the %s global',
    (name) => {
      const result = lintAt(dialectModule, `export const value = ${name};\n`);
      expect(result.output).toContain('lint/style/noRestrictedGlobals');
      expect(result.output).toContain(name);
      expect(result.status).not.toBe(0);
    },
  );

  it.each(['bun', 'bun:test'])('still refuses %s', (specifier) => {
    const result = lintAt(
      dialectModule,
      `import * as banned from '${specifier}';\n\nexport const value = banned;\n`,
    );
    expect(result.output).toContain('Node is the runtime');
    expect(result.status).not.toBe(0);
  });
});

describe('packages/editor imports no server package, database or app', () => {
  const module = 'packages/editor/src/core/model.ts';
  const message = 'The editor never imports a server package, the database or an app.';

  it('passes React, Jotai and the dialect', () => {
    const result = lintAt(
      module,
      "import { atom } from 'jotai';\nimport { useState } from 'react';\nimport { parseMarkdown } from '../dialect.ts';\n\nexport const used = [atom, useState, parseMarkdown];\n",
    );
    expect(result.output).not.toContain('lint/');
    expect(result.status).toBe(0);
  });

  it.each([
    '@fancyfolio/db',
    '@fancyfolio/db/schema',
    'postgres',
    'drizzle-orm/pg-core',
    '@vercel/blob',
    'better-auth',
    'better-auth/react',
    '@fancyfolio/api',
    '@fancyfolio/web/lib/blocks',
    '../../../../apps/web/lib/blocks.ts',
  ])('refuses %s', (specifier) => {
    const result = lintAt(
      module,
      `import * as banned from '${specifier}';\n\nexport const value = banned;\n`,
    );
    expect(result.output).toContain('lint/style/noRestrictedImports');
    expect(result.output).toContain(message);
    expect(result.status).not.toBe(0);
  });
});
