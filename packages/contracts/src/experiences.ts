import * as v from 'valibot';
import { boundedText, calendarDate, markdownText, requiredText, versionToken } from './common.ts';
import { LIMITS } from './limits.ts';

const fields = {
  company: requiredText(LIMITS.company),
  role: requiredText(LIMITS.role),
  location: boundedText(LIMITS.location),
  startsOn: calendarDate,
  endsOn: v.nullable(calendarDate),
  summaryMd: markdownText(LIMITS.summaryMd),
};

function datesInOrder({ startsOn, endsOn }: { startsOn: string; endsOn: string | null }) {
  return endsOn === null || endsOn >= startsOn;
}

export const createExperienceBody = v.pipe(
  v.strictObject(fields),
  v.check((experience) => datesInOrder(experience)),
  v.metadata({ ref: 'NewExperience' }),
);

export const updateExperienceBody = v.pipe(
  v.strictObject({ ...fields, updatedAt: versionToken }),
  v.check((experience) => datesInOrder(experience)),
  v.metadata({ ref: 'UpdateExperience' }),
);

export const experienceResponse = v.pipe(
  v.strictObject({
    id: v.string(),
    company: v.string(),
    role: v.string(),
    location: v.string(),
    startsOn: v.string(),
    endsOn: v.nullable(v.string()),
    summaryMd: v.string(),
    updatedAt: v.string(),
  }),
  v.metadata({ ref: 'Experience' }),
);

export const experienceList = v.array(experienceResponse);

export type NewExperience = v.InferOutput<typeof createExperienceBody>;
export type UpdateExperience = v.InferOutput<typeof updateExperienceBody>;
export type ExperienceResponse = v.InferOutput<typeof experienceResponse>;
