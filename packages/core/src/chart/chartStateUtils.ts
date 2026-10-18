type DeepConfigLeaf =
  | ((...args: never[]) => unknown)
  | Date
  | RegExp
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | CanvasImageSource;

/** Recursive configuration patch. Array inputs are snapshots and may be readonly. */
export type DeepPartial<T> = T extends DeepConfigLeaf
  ? T
  : T extends readonly unknown[]
    ? DeepReadonly<T>
    : T extends object
      ? { [P in keyof T]?: DeepPartial<T[P]> }
      : T;

/** Recursively readonly view used for immutable configuration snapshots. */
export type DeepReadonly<T> = T extends DeepConfigLeaf
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export function isPlainObject(v: unknown): v is Record<string, any> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
}

// Never traverse or reassign prototypes through untrusted configuration keys.
function isUnsafeConfigKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

/** Deep clone plain-data objects. Functions and non-plain objects are copied by reference. */
export function deepClone<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map(deepClone) as T;
  }
  if (!isPlainObject(obj)) return obj;
  const out: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    if (isUnsafeConfigKey(key)) continue;
    out[key] = deepClone(obj[key]);
  }
  return out as T;
}

/** Deep merge `source` into `target`. Arrays replace wholesale. Undefined keys are skipped. */
export function deepMerge(target: Record<string, any>, source: Record<string, any>): void {
  for (const key of Object.keys(source)) {
    if (isUnsafeConfigKey(key)) continue;
    const val = source[key];
    if (val === undefined) continue;
    if (
      isPlainObject(val) &&
      Object.prototype.hasOwnProperty.call(target, key) &&
      isPlainObject(target[key])
    ) {
      deepMerge(target[key], val);
    } else {
      target[key] = deepClone(val);
    }
  }
}
