declare module "@earendil-works/pi-coding-agent" {
  export function getAgentDir(): string;
  export interface ExtensionAPI {
    on(
      event: string,
      handler: (event: unknown, context: unknown) => void | Promise<void>,
    ): void;
    [key: string]: unknown;
  }
}
