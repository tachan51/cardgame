// stats.ts をワーカーで動かすための入口（ワーカーでは tsx の読み込みを自分で行う）
import { tsImport } from 'tsx/esm/api';
await tsImport('./stats.ts', import.meta.url);
