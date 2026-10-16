# Fancyfolio

Fancyfolio is an open source, multi-tenant platform where developers publish a career portfolio: a profile, an experience timeline, projects and case studies written in Markdown. Every portfolio is meant to get its own subdomain and, optionally, a custom domain.

## Status

Works today:

- The Postgres schema for tenants, profiles, experience, projects, case studies and custom domains, with Drizzle migrations and forced row-level security on every tenant table.
- A read-only HTTP API: `GET /api/health`, `GET /api/v1/sites/:key` and `GET /api/v1/sites/:key/case-studies/:slug`, which serve one portfolio, looked up by its subdomain or a verified custom domain.
- The editor core, with no user interface yet: the Markdown dialect, a block model with invertible ops, lossless load and save, and a Jotai store with undo.
- The web app's landing page.

Next: sign-up and sign-in, the dashboard with its Markdown editor, public portfolio pages on subdomains, attaching custom domains and image uploads.

## Stack

- Web: Next.js (App Router), React, TypeScript, Tailwind CSS
- API: Hono on Node.js
- Database: Postgres on Supabase, Drizzle ORM, row-level security for tenant isolation
- Auth: Better Auth (its tables are in the schema; sign-in is not wired up yet)
- Tests: Vitest, Playwright, GitHub Actions
- Hosting: Vercel, with the web app and the API as two services

## Architecture

```
apps/web            Next.js front end; opens no database connection
apps/api            Hono API; the only process that opens a database connection
packages/db         Drizzle schema, SQL migrations, database roles and the tenant-context helper
packages/contracts  Valibot schemas: the API's response shapes and the env parsing both apps use
packages/editor     Editor core: Markdown dialect, block model, ops, load and save, store with undo
```

Tenant isolation lives in the database. Every tenant table carries a `tenant_id` and forced row-level security policies. The API connects as `ff_app`, a role without `BYPASSRLS`, and reaches tenant data only through `withTenant`, which runs each unit of work in a transaction that sets `app.tenant_id` with `set_config(..., true)`. `withTenant` refuses to run on a role that has `SUPERUSER` or `BYPASSRLS`. Better Auth's tables are reachable only by `ff_auth`.

### The editor package

`packages/editor` holds the editor core. It runs without React, the DOM or I/O; the caller passes in the clock and the block ids.

- **Dialect.** One parser and serializer for every Markdown body: CommonMark with GFM tables, strikethrough, task lists, footnotes and block directives. A body past its parser limits, such as nesting depth or table size, reads as one block of literal source.
- **Blocks and ops.** A document is an ordered list of blocks with ids: paragraphs, headings and raw blocks. Five ops change it: insert text, delete a range, split a block, merge blocks and set a block's type. Each op returns its exact inverse, and an op that does not fit the document is refused before anything changes.
- **Load and save.** `load` turns a body into blocks and keeps each block's source. `save` writes an unedited document back byte for byte. After an edit, it parses the new body at most twice and returns it only if every block reads back as it is in the document. Otherwise it returns a refusal that names the block or the parser limit, and the document stays as it was.
- **Store and undo.** `createEditor` keeps the blocks in a vanilla Jotai store, one atom per block, so an op updates only the blocks it changes. Undo and redo replay the inverses. Typing in one block is one undo step until a pause of more than a second, a typed newline or 2 seconds from its first keystroke. The history keeps 500 steps.

Limits:

- Only paragraphs and headings of plain text are edited as text. Everything else (lists, quotes, code, tables, HTML, images, links, emphasis, directives) loads as a raw block that holds its exact source.
- Text never moves between a raw block and a text block, and raw source is never cut in two or joined to other raw source.
- A save is refused, not repaired, when a block would read differently in the new body. Showing that refusal on the block is up to the user interface.
- `load` refuses a body with a NUL character or a lone surrogate.
- There is no typing, rendering, collaboration or storage yet.

## Development

Requires Node.js 24 (the `engines` field of both apps) and pnpm 12 (`packageManager` in the root `package.json`).

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
```

## Testing

`pnpm test:unit` runs every suite except the database suite and needs no database:

```sh
pnpm test:unit
```

The database suite (`pnpm test:db`, also part of `pnpm test`) needs:

- Postgres 17 listening on `127.0.0.1:5432`.
- `openssl` on the `PATH` and the loopback address `127.0.0.2` (reachable by default on Linux); one suite starts a TLS server there with a throwaway certificate.
- The owner role and the Supabase roles, created once as a Postgres superuser:

  ```sh
  sudo -u postgres psql -v ON_ERROR_STOP=1 \
    -c "create role fancyfolio_owner login nosuperuser createdb createrole bypassrls password 'choose-an-owner-password'" \
    -c "create role anon nologin noinherit" \
    -c "create role authenticated nologin noinherit" \
    -c "create role service_role nologin noinherit bypassrls"
  ```

- Three environment variables. `TEST_DATABASE_URL` must name the `fancyfolio_test` database on a loopback host; each run drops and recreates that database, applies the migrations and sets the login passwords of the runtime roles `ff_app` and `ff_auth`. The two passwords are 32 to 128 printable ASCII characters, spaces excluded.

  ```sh
  export TEST_DATABASE_URL=postgres://fancyfolio_owner:choose-an-owner-password@127.0.0.1:5432/fancyfolio_test
  export FF_APP_PASSWORD=choose-an-app-password-of-32-chars-or-more
  export FF_AUTH_PASSWORD=choose-an-auth-password-of-32-chars-or-more
  pnpm test
  ```

The browser tests build the web app, start it with the API and run against them; they need no database:

```sh
pnpm exec playwright install chromium
pnpm e2e
```

On a fresh Linux machine, add `--with-deps` to the install command to get the browser's system libraries.

## License

MIT, see [LICENSE](LICENSE).
