import { build } from "./build-common.js";

await build({
    splitting: true,
    minify: true,
    entrypoints: [
        "website/editor.html",
    ],
    outdir: "./docs",
    naming: {
        entry: "[dir]/[name].[ext]",
        chunk: "[dir]/[hash].[ext]",
        asset: "[dir]/[hash].[ext]",
    },
    plugins: [],
});

console.log("Web Build OK");

