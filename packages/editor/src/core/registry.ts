import { heading } from './heading.ts';
import { isCanonicalText, isRecord, jsonOf } from './model.ts';
import { paragraph } from './paragraph.ts';
import { raw } from './raw.ts';
import type { AnyComponent, Fields, Json, Registered, Registry } from './types.ts';

export function registryOf(components: readonly AnyComponent[]): Registry {
  const named = new Map<string, Registered>([[raw.name, raw]]);
  const matches = new Map<string, AnyComponent>();
  const listed: readonly AnyComponent[] = [paragraph, heading, ...components];
  for (const component of listed) {
    const { name, markdown } = component;
    if (named.has(name)) throw new RangeError(`component ${name} is registered twice`);
    if (matches.has(markdown.match)) {
      throw new RangeError(`markdown ${markdown.match} is read by two components`);
    }
    if (new Set(component.fields).size !== component.fields.length) {
      throw new RangeError(`component ${name} names a field twice`);
    }
    named.set(name, component);
    matches.set(markdown.match, component);
  }
  return { components: named, matches };
}

export const builtins = registryOf([]);

function validated(component: Registered, props: unknown) {
  try {
    return component.props['~standard'].validate(props);
  } catch {
    return undefined;
  }
}

export function propsFor(component: Registered, props: unknown): Json | undefined {
  const result = validated(component, props);
  if (result instanceof Promise) {
    result.catch(() => undefined);
    return undefined;
  }
  if (result === undefined || result.issues !== undefined) return undefined;
  return jsonOf(result.value);
}

export function fieldsFor(component: Registered, fields: unknown): Fields | undefined {
  if (!isRecord(fields) || Object.keys(fields).length !== component.fields.length) {
    return undefined;
  }
  const entries: [string, string][] = [];
  for (const name of component.fields) {
    const text = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (typeof text !== 'string' || !isCanonicalText(text)) return undefined;
    entries.push([name, text]);
  }
  return Object.freeze(Object.fromEntries(entries));
}
