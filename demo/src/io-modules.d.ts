declare module "virtual:nirs4all-io" {
  export * from "@nirs4all/io-wasm";
  export function init(): Promise<void>;
}
declare module "virtual:nirs4all-formats" {
  export * from "@nirs4all/formats-wasm";
  export function init(): Promise<void>;
}
