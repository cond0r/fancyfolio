import * as v from 'valibot';

const journalSchema = v.object({
  entries: v.array(v.object({ idx: v.number(), when: v.number() })),
});

export function latestMigration(journalText: string): string {
  const { entries } = v.parse(journalSchema, JSON.parse(journalText));
  const last = entries.at(-1);
  if (last === undefined) {
    throw new Error('the migration journal has no entries; generate a migration first');
  }
  const ordered = entries.every(
    (entry, index) => entry.idx === index && (index === 0 || entry.when > entries[index - 1].when),
  );
  if (!ordered) {
    throw new Error(
      'the migration journal is out of order: each entry needs the next index and a later time',
    );
  }
  return String(last.when);
}
