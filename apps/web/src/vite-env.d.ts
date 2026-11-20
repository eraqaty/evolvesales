/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Git SHA baked in at build time (set by CI); "dev" locally. */
  readonly VITE_APP_VERSION?: string;
}
