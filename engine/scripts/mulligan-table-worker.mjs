// mulligan-table.ts をワーカーで動かすための入口
import { tsImport } from 'tsx/esm/api';
await tsImport('./mulligan-table.ts', import.meta.url);
