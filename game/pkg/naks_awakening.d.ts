/* tslint:disable */
/* eslint-disable */

export class Game {
    free(): void;
    [Symbol.dispose](): void;
    add_player(slot: number): void;
    add_player_with_save(slot: number, save_json: string): void;
    apply_host_msg(bytes: Uint8Array, now_ms: number): void;
    content_hash(): bigint;
    /**
     * Sound cues for the viewpoint player's screen since the last call.
     */
    drain_audio(viewpoint: number): Uint16Array;
    /**
     * Net events since the last call, wrapped for the reliable channel.
     * Empty result means nothing to send.
     */
    drain_events_bytes(): Uint8Array;
    /**
     * Toast messages for the viewpoint player since the last call (JSON array).
     */
    drain_toasts(viewpoint: number): string;
    encode_input(buttons: number): Uint8Array;
    /**
     * Wrap a save for the reliable channel (host -> the owning client).
     */
    encode_save_state(slot: number): Uint8Array;
    /**
     * Encode a UI action for sending to the host (client role).
     */
    encode_ui_action(json: string): Uint8Array;
    export_save(slot: number): string;
    /**
     * Decode and apply one message from the client in `slot`.
     */
    handle_client_msg(slot: number, bytes: Uint8Array): void;
    /**
     * Panics on malformed content; the bundle is validated at build time
     * by tools/build-maps.mjs + tools/check-content.mjs.
     */
    constructor(content_json: string, role: number, seed: bigint);
    remove_player(slot: number): void;
    render_frame(viewpoint: number, now_ms: number): Uint16Array;
    set_input(slot: number, buttons: number): void;
    set_local_slot(slot: number): void;
    /**
     * Serialized snapshot to broadcast.
     */
    snapshot_bytes(): Uint8Array;
    state_hash(): bigint;
    /**
     * A save pushed by the host since the last call (client role).
     */
    take_pending_save(): string | undefined;
    tick(): void;
    tick_count(): number;
    /**
     * Apply a UI action for a local (host-side) player.
     */
    ui_action(slot: number, json: string): void;
    /**
     * Inventory/equipment/skills/quests JSON for the UI overlay (role-aware).
     */
    ui_state(slot: number): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_game_free: (a: number, b: number) => void;
    readonly game_add_player: (a: number, b: number) => void;
    readonly game_add_player_with_save: (a: number, b: number, c: number, d: number) => void;
    readonly game_apply_host_msg: (a: number, b: number, c: number, d: number) => void;
    readonly game_content_hash: (a: number) => bigint;
    readonly game_drain_audio: (a: number, b: number, c: number) => void;
    readonly game_drain_events_bytes: (a: number, b: number) => void;
    readonly game_drain_toasts: (a: number, b: number, c: number) => void;
    readonly game_encode_input: (a: number, b: number, c: number) => void;
    readonly game_encode_save_state: (a: number, b: number, c: number) => void;
    readonly game_encode_ui_action: (a: number, b: number, c: number, d: number) => void;
    readonly game_export_save: (a: number, b: number, c: number) => void;
    readonly game_handle_client_msg: (a: number, b: number, c: number, d: number) => void;
    readonly game_new: (a: number, b: number, c: number, d: bigint) => number;
    readonly game_remove_player: (a: number, b: number) => void;
    readonly game_render_frame: (a: number, b: number, c: number, d: number) => void;
    readonly game_set_input: (a: number, b: number, c: number) => void;
    readonly game_set_local_slot: (a: number, b: number) => void;
    readonly game_snapshot_bytes: (a: number, b: number) => void;
    readonly game_state_hash: (a: number) => bigint;
    readonly game_take_pending_save: (a: number, b: number) => void;
    readonly game_tick: (a: number) => void;
    readonly game_tick_count: (a: number) => number;
    readonly game_ui_action: (a: number, b: number, c: number, d: number) => void;
    readonly game_ui_state: (a: number, b: number, c: number) => void;
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
