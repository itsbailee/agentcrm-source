const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/index.jsx'],
  bundle: true,
  outfile: 'public/bundle.js',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  loader: { '.js': 'jsx', '.jsx': 'jsx' },
}).then(() => {
  console.log('Bundle built successfully');
}).catch((e) => { console.error(e); process.exit(1); });
