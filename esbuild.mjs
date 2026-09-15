import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const context = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    // The vscode module is provided by the host at runtime and must never be bundled.
    external: ['vscode'],
    // Prefer each dependency's ESM build over its CJS/UMD one. jsonc-parser's UMD entry
    // calls require() through an indirect binding that esbuild cannot follow, so those
    // requires survive into the bundle and blow up at load time with
    // "Cannot find module './impl/format'". The ESM build is statically analysable.
    mainFields: ['module', 'main'],
    minify: production,
    sourcemap: !production,
    logLevel: 'info',
});

if (watch) {
    await context.watch();
} else {
    await context.rebuild();
    await context.dispose();
}
