// weights-tune.ts をワーカーで動かすための入口
import { tsImport } from 'tsx/esm/api';
await tsImport('./weights-tune.ts', import.meta.url);
