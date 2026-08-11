import type { JSONSchema, JSONValue } from '../types.js';

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: string[] };

export function validateArguments(
  schema: JSONSchema,
  value: unknown,
): ValidationResult {
  const errors: string[] = [];
  validateValue(schema, value, '$', errors);
  return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function validateValue(
  schema: JSONSchema,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (schema.enum !== undefined && !schema.enum.some((item) => jsonEquals(item, value))) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }

  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push(`${path} must be ${article(schema.type)} ${schema.type}; received ${kindOf(value)}`);
    return;
  }

  if (schema.type === 'object' && isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) {
        validateValue(childSchema, child, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      validateValue(schema.items!, item, `${path}[${index}]`, errors);
    });
  }
}

function matchesType(type: NonNullable<JSONSchema['type']>, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEquals(expected: JSONValue, actual: unknown): boolean {
  try {
    return JSON.stringify(expected) === JSON.stringify(actual);
  } catch {
    return false;
  }
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function article(type: NonNullable<JSONSchema['type']>): 'a' | 'an' {
  return type === 'array' || type === 'integer' || type === 'object' ? 'an' : 'a';
}
