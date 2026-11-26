import * as v from 'valibot';
import { boundedText, requiredText, versionToken } from './common.ts';
import { LIMITS } from './limits.ts';
import { hasNoCredentials, isHttpsUrl } from './predicates.ts';

const httpsUrl = v.nullable(
  v.pipe(
    v.string(),
    v.check(isHttpsUrl),
    v.check(hasNoCredentials),
    v.description(`An https: URL of at most ${LIMITS.url} characters, no credentials`),
  ),
);

const fields = {
  name: requiredText(LIMITS.projectName),
  description: boundedText(LIMITS.description),
  url: httpsUrl,
  repoUrl: httpsUrl,
  tags: v.pipe(v.array(requiredText(LIMITS.tag)), v.maxLength(LIMITS.tags)),
};

export const createProjectBody = v.pipe(v.strictObject(fields), v.metadata({ ref: 'NewProject' }));

export const updateProjectBody = v.pipe(
  v.strictObject({ ...fields, updatedAt: versionToken }),
  v.metadata({ ref: 'UpdateProject' }),
);

export const projectResponse = v.pipe(
  v.strictObject({
    id: v.string(),
    name: v.string(),
    description: v.string(),
    url: v.nullable(v.string()),
    repoUrl: v.nullable(v.string()),
    tags: v.array(v.string()),
    updatedAt: v.string(),
  }),
  v.metadata({ ref: 'Project' }),
);

export const projectList = v.array(projectResponse);

export type NewProject = v.InferOutput<typeof createProjectBody>;
export type UpdateProject = v.InferOutput<typeof updateProjectBody>;
export type ProjectResponse = v.InferOutput<typeof projectResponse>;
