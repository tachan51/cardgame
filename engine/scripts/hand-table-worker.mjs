// hand-table.ts をワーカーで動かすための入口
import { tsImport } from 'tsx/esm/api';
await tsImport('./hand-table.ts', import.meta.url);
