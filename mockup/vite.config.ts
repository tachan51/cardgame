import { defineConfig } from 'vite';

// data/ はリポジトリ直下にあるので、開発サーバーから読めるよう1つ上を許可する
export default defineConfig({
  base: './',
  server: { fs: { allow: ['..'] } },
});
