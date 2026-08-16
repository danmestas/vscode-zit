const esbuild = require('esbuild');
const minify = process.argv.includes('--minify');
const sourcemap = process.argv.includes('--sourcemap');

function buildConfig(entryPoint, outfile) {
  return {
    minify,
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    sourcemap,
    target: 'node18',
    format: 'cjs',
    external: ['vscode', './gitExport', './praise'],
    ...(outfile ? {outfile} : {}),
  }
}

async function main() {
  await Promise.all([
    esbuild.build(
      {...buildConfig('./src/main.ts', 'out/main.js')}
    ),
    esbuild.build(
      {...buildConfig('./src/praise.ts', 'out/praise.js'), external: ['vscode']}
    ),
    esbuild.build(
      {...buildConfig('./src/gitExport.ts', 'out/gitExport.js')}
    ),
  ])
  console.log('Zit extension JavaScript files are ready')
}

main()
