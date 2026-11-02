/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FLOQ_RUNTIME_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

