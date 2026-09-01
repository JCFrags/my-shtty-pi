declare module "@earendil-works/pi-tui" {
  export interface Component {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate?(): void;
  }

  export interface Terminal {
    readonly rows: number;
    readonly columns: number;
  }

  export interface TUI {
    readonly terminal: Terminal;
    requestRender(): void;
  }

  export interface OverlayHandle {
    hide(): void;
    setHidden(hidden: boolean): void;
    isHidden(): boolean;
    focus(): void;
    unfocus(options?: { target?: Component | null }): void;
    isFocused(): boolean;
  }

  export type SizeValue = number | `${number}%`;
  export type OverlayAnchor =
    | "center"
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "top-center"
    | "bottom-center"
    | "left-center"
    | "right-center";

  export interface OverlayOptions {
    width?: SizeValue;
    minWidth?: number;
    maxHeight?: SizeValue;
    anchor?: OverlayAnchor;
    offsetX?: number;
    offsetY?: number;
    row?: SizeValue;
    col?: SizeValue;
    margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
    visible?: (terminalWidth: number, terminalHeight: number) => boolean;
    nonCapturing?: boolean;
  }

  export type KeyId = string;
  export function matchesKey(data: string, keyId: KeyId): boolean;
  export function isKeyRelease(data: string): boolean;
  export function truncateToWidth(text: string, width: number, ellipsis?: string): string;
  export function visibleWidth(text: string): number;
  export function wrapTextWithAnsi(text: string, width: number): string[];
}
