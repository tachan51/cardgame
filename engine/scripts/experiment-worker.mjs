// experiment.ts をワーカーで動かすための入口
import { tsImport } from 'tsx/esm/api';
await tsImport('./experiment.ts', import.meta.url);
