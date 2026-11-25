import * as v from 'valibot';
import { boundedText, markdownText, requiredText, versionToken } from './common.ts';
import { LIMITS } from './limits.ts';
import { isLinkUrl } from './predicates.ts';

const link = v.strictObject({
  label: requiredText(LIMITS.linkLabel),
  url: v.pipe(
    v.string(),
    v.check(isLinkUrl),
    v.description(`An https: or mailto: URL of at most ${LIMITS.url} characters, no credentials`),
  ),
});

export const updateProfileBody = v.pipe(
  v.strictObject({
    displayName: boundedText(LIMITS.displayName),
    headline: boundedText(LIMITS.headline),
    location: boundedText(LIMITS.location),
    bioMd: markdownText(LIMITS.bioMd),
    links: v.pipe(v.array(link), v.maxLength(LIMITS.links)),
    updatedAt: versionToken,
  }),
  v.metadata({ ref: 'UpdateProfile' }),
);

export const profileResponse = v.pipe(
  v.strictObject({
    displayName: v.string(),
    headline: v.string(),
    location: v.string(),
    bioMd: v.string(),
    avatarUrl: v.nullable(v.string()),
    links: v.array(v.strictObject({ label: v.string(), url: v.string() })),
    updatedAt: v.string(),
  }),
  v.metadata({ ref: 'Profile' }),
);

export type UpdateProfile = v.InferOutput<typeof updateProfileBody>;
export type ProfileResponse = v.InferOutput<typeof profileResponse>;
