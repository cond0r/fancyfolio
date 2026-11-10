import * as v from 'valibot';

export const calloutProps = v.strictObject({ tone: v.picklist(['info', 'warning']) });
export const metricProps = v.strictObject({});

export type CalloutProps = v.InferOutput<typeof calloutProps>;
export type MetricProps = v.InferOutput<typeof metricProps>;
