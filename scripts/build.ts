Bun.build({
    sourcemap: true,
    format: "esm",
    splitting: true,
    outdir: "dist/",
    entrypoints: ["src/index.ts", "src/indextest.ts", "src/doc.ts"],
    naming: {
        entry: "[dir]/[name].[ext]",
        chunk: "[dir]/[hash].[ext]",
    },
    minify: process.argv.includes('--minify'),
    target: "browser",
}).then(() => console.log("Build OK"));
