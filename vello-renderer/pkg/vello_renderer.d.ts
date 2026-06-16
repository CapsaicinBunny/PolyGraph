/* tslint:disable */
/* eslint-disable */

export class VelloCanvas {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Initialize a WebGPU device + surface for the given canvas and create a Vello renderer.
     */
    static create(canvas: HTMLCanvasElement): Promise<VelloCanvas>;
    /**
     * POC render: a single rounded card with a border and left accent bar.
     */
    render(): void;
    resize(width: number, height: number): void;
}

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_vellocanvas_free: (a: number, b: number) => void;
    readonly start: () => void;
    readonly vellocanvas_create: (a: any) => any;
    readonly vellocanvas_render: (a: number) => [number, number];
    readonly vellocanvas_resize: (a: number, b: number, c: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h8d0a2bd66ba9dad6: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h26b056603e6c5143: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h1f61da4447a6259c: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
