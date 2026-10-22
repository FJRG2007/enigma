/**
 * Minimal ambient declaration for Bun's built-in `bun:ffi` module, the same way
 * `gate/db/bun-sqlite.d.ts` covers `bun:sqlite`: the repo does not depend on
 * `bun-types`, so this covers only the surface browser-jail.ts uses.
 */
declare module "bun:ffi" {
    /** Argument and return types a foreign function is declared with. */
    export const FFIType: {
        readonly ptr: number;
        readonly i32: number;
        readonly u32: number;
        readonly i64: number;
        readonly u64: number;
    };

    /** A foreign function's declared argument and return types. */
    export interface FFIFunction {
        args: readonly number[];
        returns: number;
    }

    /** Open a shared library and bind the named symbols. */
    export function dlopen<T extends Record<string, FFIFunction>>(path: string, symbols: T): {
        symbols: { [K in keyof T]: (...args: any[]) => any };
        close(): void;
    };

    /** The address of a typed array's memory, to pass as a pointer argument. */
    export function ptr(view: ArrayBufferView): number;
}
