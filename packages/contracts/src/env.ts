import * as v from 'valibot';

export function parseEnv<TSchema extends v.GenericSchema>(
  schema: TSchema,
  source: Record<string, string | undefined>,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, source);
  if (result.success) return result.output;
  const names = result.issues.map(
    (issue) => `${v.getDotPath(issue)} (${issue.input === undefined ? 'missing' : 'malformed'})`,
  );
  throw new Error(`Invalid environment: ${[...new Set(names)].join(', ')}`);
}

const refusal = 'Database URL must be postgres://user:password@host[:port]/database, nothing else';

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new Error(refusal);
  }
}

export function parseDatabaseUrl(url: string) {
  const parsed = URL.parse(url);
  if (
    parsed === null ||
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.hostname === '' ||
    /[,[]/.test(parsed.hostname) ||
    !/^\/[^/]+$/.test(parsed.pathname)
  ) {
    throw new Error(refusal);
  }
  const database = decodePart(parsed.pathname.slice(1));
  const username = decodePart(parsed.username);
  const password = decodePart(parsed.password);
  if (![database, username].every((part) => /^[^\p{Cc}]+$/u.test(part))) {
    throw new Error(refusal);
  }
  return {
    host: parsed.hostname.toLowerCase(),
    port: Number(parsed.port || 5432),
    database,
    user: username,
    password,
  };
}
