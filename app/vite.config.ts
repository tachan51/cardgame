import { defineConfig } from 'vite';

// GitHub Pages のサブパスでも動くよう相対パスで書き出す。エンジンとカードデータはリポジトリの上の階層から読む
export default defineConfig({
  base: './',
  server: { fs: { allow: ['..'] } },
});
