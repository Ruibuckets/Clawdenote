import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({base:'./',plugins:[react()],optimizeDeps:{exclude:['mupdf']},assetsInclude:['**/*.wasm'],build:{target:'esnext',chunkSizeWarningLimit:2000},server:{port:5173,strictPort:true}});
