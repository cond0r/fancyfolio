import * as v from 'valibot';

export function parseEnv<TSchema extends v.ObjectSchema<v.ObjectEntries, undefined>>(
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
