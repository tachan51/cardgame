// explore-decks.ts をワーカーで動かすための入口
import { tsImport } from 'tsx/esm/api';
await tsImport('./explore-decks.ts', import.meta.url);
