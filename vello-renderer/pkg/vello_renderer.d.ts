/* tslint:disable */
/* eslint-disable */

export class VelloCanvas {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static create(canvas: HTMLCanvasElement): Promise<VelloCanvas>;
    /**
     * Fit all nodes into the viewport; returns [x, y, scale] for the caller to keep.
     */
    fit(): Float64Array;
    /**
     * Return the id of the topmost node under a screen point, if any.
     */
    pick(px: number, py: number): string | undefined;
    render(): void;
    resize(width: number, height: number): void;
    set_camera(x: number, y: number, scale: number): void;
    /**
     * Replace the graph data (JSON: { nodes:[...], edges:[...] }).
     */
    set_data(json: string): void;
    /**
     * Marching-ants dash offset (screen px), advanced by the animation loop.
     */
    set_phase(phase: number): void;
    set_search(query: string): void;
    set_selection(id?: string | null): void;
}

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_vellocanvas_free: (a: number, b: number) => void;
    readonly start: () => void;
    readonly vellocanvas_create: (a: any) => any;
    readonly vellocanvas_fit: (a: number) => [number, number];
    readonly vellocanvas_pick: (a: number, b: number, c: number) => [number, number];
    readonly vellocanvas_render: (a: number) => [number, number];
    readonly vellocanvas_resize: (a: number, b: number, c: number) => void;
    readonly vellocanvas_set_camera: (a: number, b: number, c: number, d: number) => void;
    readonly vellocanvas_set_data: (a: number, b: number, c: number) => [number, number];
    readonly vellocanvas_set_phase: (a: number, b: number) => void;
    readonly vellocanvas_set_search: (a: number, b: number, c: number) => void;
    readonly vellocanvas_set_selection: (a: number, b: number, c: number) => void;
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
