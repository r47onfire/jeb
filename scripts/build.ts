/**
 * @file Build script: bundles the package with Bun into `dist/` as ESM, with
 *   code splitting and sourcemaps. The only entry point is the main module.
 *   Pass `--minify` on the command line to also minify the output.
 */
Bun.build({
    sourcemap: true,
    format: "esm",
    splitting: true,
    outdir: "dist/",
    entrypoints: ["src/index.ts"],
    naming: {
        entry: "[dir]/[name].[ext]",
        chunk: "[dir]/[hash].[ext]",
    },
    minify: process.argv.includes("--minify"),
    target: "browser",
}).then(() => console.log("Build OK"));
