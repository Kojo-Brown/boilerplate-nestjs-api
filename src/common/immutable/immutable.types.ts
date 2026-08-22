/**
 * Compile-time half of the immutability story.
 *
 * `deepFreeze` is the runtime half and only runs outside production, so these
 * types are what carry the guarantee into a deployed build: a write that
 * `DeepReadonly` rejects never reaches the runtime check in the first place.
 * The two halves stop different things and neither subsumes the other — see
 * [docs/immutability.md](../../../docs/immutability.md).
 */

/** Values that have no interior to make readonly. */
type ImmutablePrimitive = string | number | boolean | bigint | symbol | undefined | null;

/**
 * Values `DeepReadonly` deliberately passes through untouched.
 *
 * Mapping over these would be actively wrong rather than merely useless:
 * `DeepReadonly<Date>` under a naive mapped type produces an object with
 * `Date`'s methods marked readonly and *no* call signatures preserved on the
 * instance, so `date.toISOString()` stops type-checking. Functions lose their
 * call signature the same way. Buffers and typed arrays are excluded because
 * `deepFreeze` cannot freeze them at runtime either (`Object.freeze` throws on
 * a non-empty array-buffer view), and a type that promised more than the
 * runtime delivers is the worst of both.
 */
type ImmutableOpaque =
  | Date
  | RegExp
  | Error
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- matching *any* function, which is what `Function` means; a signature-bearing type would only match the arities it names.
  | Function
  | Promise<unknown>
  | ArrayBuffer
  | SharedArrayBuffer
  | ArrayBufferView;

/**
 * Recursively marks `T` readonly.
 *
 * `Map` and `Set` map to their `Readonly*` counterparts rather than to a
 * frozen object, because those are the only forms the compiler will refuse
 * `.set()`/`.add()` against. That matters more here than elsewhere:
 * `Object.freeze` does **not** stop `map.set(…)` at runtime — the entries live
 * in an internal slot, not in properties — so for collections the type layer is
 * the *only* layer doing the work.
 */
export type DeepReadonly<T> = T extends ImmutablePrimitive
  ? T
  : T extends ImmutableOpaque
    ? T
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends ReadonlySet<infer V>
        ? ReadonlySet<DeepReadonly<V>>
        : T extends readonly (infer E)[]
          ? readonly DeepReadonly<E>[]
          : { readonly [K in keyof T]: DeepReadonly<T[K]> };

/**
 * Drops one level of `readonly`, for the narrow case of building a value up
 * before it is frozen and handed out.
 *
 * Deliberately shallow. A `DeepMutable` would be an invitation to launder a
 * shared frozen value back into a mutable one, which is the single thing this
 * module exists to prevent — the honest way to get a mutable copy of a frozen
 * value is to copy it, which is what {@link module:structural-sharing} does.
 */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
