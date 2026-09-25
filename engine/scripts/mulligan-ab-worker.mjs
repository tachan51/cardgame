// mulligan-ab.ts をワーカーで動かすための入口
import { tsImport } from 'tsx/esm/api';
await tsImport('./mulligan-ab.ts', import.meta.url);
