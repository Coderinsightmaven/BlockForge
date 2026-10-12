/**
 * Prototype-pollution guards. Egg files and server config files are untrusted; their keys must
 * never reach `Object.prototype` through `obj[key] = …` (the `__proto__` setter) or through
 * descending into inherited properties. Keys are only read/written as own data properties.
 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

export function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Own-property read (never inherited, never a prototype accessor). */
export function getOwn<T = unknown>(obj: object, key: PropertyKey): T | undefined {
  return hasOwn(obj, key) ? ((obj as Record<PropertyKey, unknown>)[key] as T) : undefined;
}

/** Defines an own, enumerable data property — never invokes the `__proto__` setter. */
export function defineOwn<T extends object>(obj: T, key: PropertyKey, value: unknown): T {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  return obj;
}

/** An empty object with no prototype (no inherited keys to descend into). */
export function nullProtoObject<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
