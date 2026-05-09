import { build } from "./build-common";

await build({
    splitting: true,
    outdir: "dist/",
    entrypoints: ["src/index.ts"],
    naming: {
        entry: "[dir]/[name].[ext]",
        chunk: "[dir]/[hash].[ext]",
    },
    minify: process.argv.includes('--minify'),
    target: "browser",
});
console.log("Build OK");
