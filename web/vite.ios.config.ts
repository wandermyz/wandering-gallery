import { defineConfig } from 'vite';

/**
 * The iOS app's Markdown renderer (src/ios/markdown-bundle.ts): one self-contained script,
 * Mermaid included, checked in to the app's resources so Xcode builds don't need Node.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: '../ios/WanderingGallery/Resources/Markdown',
    emptyOutDir: false,
    target: ['es2022', 'safari16'],
    lib: {
      entry: 'src/ios/markdown-bundle.ts',
      formats: ['iife'],
      name: 'wgMarkdown',
      fileName: () => 'markdown.js',
    },
  },
});
