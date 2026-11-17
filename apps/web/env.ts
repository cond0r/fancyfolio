import { hostEnv } from '@fancyfolio/contracts';
import * as v from 'valibot';

export const apiEnv = v.intersect([
  hostEnv,
  v.object({ API_URL: v.pipe(v.string(), v.url(), v.regex(/^https?:\/\//)) }),
]);
