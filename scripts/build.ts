Bun.build({
    sourcemap: true,
    target: "browser",
    format: "esm",
    splitting: true,
    outdir: "dist/",
    entrypoints: ["src/index.ts"],
    naming: {
        entry: "[dir]/[name].[ext]",
        chunk: "[dir]/[hash].[ext]",
    },
    minify: process.argv.includes('--minify'),
}).then(() => console.log("Build OK"));
