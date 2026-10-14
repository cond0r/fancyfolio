# Fancyfolio

Fancyfolio is an open source, multi-tenant platform where developers publish a career portfolio: a profile, an experience timeline, projects and case studies written in Markdown. Every portfolio gets its own subdomain and can be served from a custom domain.

## Stack

- Web: Next.js (App Router), React, TypeScript, Tailwind CSS
- Database: Postgres on Supabase, Drizzle ORM, row-level security for tenant isolation
- Auth: Better Auth
- Files: Vercel Blob
- Tests: Vitest, Playwright, GitHub Actions
- Hosting: Vercel, with wildcard subdomains and custom domains

## Development

Requires Node.js 24 and pnpm 12.

```sh
pnpm install
pnpm check
pnpm typecheck
pnpm test
```

## License

MIT, see [LICENSE](LICENSE).
