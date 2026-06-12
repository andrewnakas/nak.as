/* tslint:disable */
/* eslint-disable */

export class Game {
    free(): void;
    [Symbol.dispose](): void;
    add_player(slot: number): void;
    /**
     * Panics on malformed content; world.json is validated at build time
     * by tools/build-maps.mjs.
     */
    constructor(content_json: string, seed: bigint);
    render_frame(viewpoint: number): Uint16Array;
    set_input(slot: number, buttons: number): void;
    state_hash(): bigint;
    tick(): void;
    tick_count(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_game_free: (a: number, b: number) => void;
    readonly game_add_player: (a: number, b: number) => void;
    readonly game_new: (a: number, b: number, c: bigint) => number;
    readonly game_render_frame: (a: number, b: number, c: number) => void;
    readonly game_set_input: (a: number, b: number, c: number) => void;
    readonly game_state_hash: (a: number) => bigint;
    readonly game_tick: (a: number) => void;
    readonly game_tick_count: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
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
