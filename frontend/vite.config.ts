import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  build: { chunkSizeWarningLimit: 1800, rollupOptions: { output: { manualChunks: { charts: ['echarts'], ui: ['antd', '@ant-design/icons'] } } } },
  // 整页 antd 表单在 jsdom 里渲染一次约 3–10 秒，默认 5 秒会随机超时——超时是环境耗时，
  // 不是断言失败，但会让 `npm test` 报红，掩盖真正的问题。断言本身仍按项计时。
  test: { testTimeout: 20000 },
});
