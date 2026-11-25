import * as v from 'valibot';
import { LIMITS } from './limits.ts';
import { isCalendarDate, isVersionToken, withinFenceLimit } from './predicates.ts';

export const errorBody = v.pipe(
  v.strictObject({ error: v.string(), requestId: v.string() }),
  v.metadata({ ref: 'ErrorBody' }),
);

const text = v.pipe(
  v.string(),
  v.check(
    (value) => value.isWellFormed() && !value.includes('\u0000'),
    'Well-formed text without NUL characters',
  ),
);

export function boundedText(max: number) {
  return v.pipe(text, v.maxLength(max));
}

export function requiredText(max: number) {
  return v.pipe(text, v.minLength(1), v.maxLength(max));
}

export function markdownText(max: number) {
  return v.pipe(
    text,
    v.maxLength(max),
    v.check(withinFenceLimit),
    v.description(`Markdown with at most ${LIMITS.markdownFences} ::: fences`),
  );
}

export const calendarDate = v.pipe(
  v.string(),
  v.check(isCalendarDate),
  v.description('A calendar date, YYYY-MM-DD'),
);

export const versionToken = v.pipe(
  v.string(),
  v.check(isVersionToken),
  v.description('The updatedAt value read with the item, sent back unchanged'),
);

export const itemParams = v.strictObject({
  id: v.pipe(v.string(), v.uuid(), v.description('The id of one of your items')),
});

export const createHeaders = v.object({
  'idempotency-key': v.pipe(
    v.string(),
    v.uuid(),
    v.description('A new uuid per form; sending it again answers the item it created'),
  ),
});

export const deleteBody = v.pipe(
  v.strictObject({ updatedAt: versionToken }),
  v.metadata({ ref: 'DeleteItem' }),
);

export const deletedResponse = v.pipe(
  v.strictObject({ id: v.string() }),
  v.metadata({ ref: 'Deleted' }),
);

export type ErrorBody = v.InferOutput<typeof errorBody>;
