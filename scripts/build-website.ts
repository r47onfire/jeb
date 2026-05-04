import markdown from "markdown-it";
import attrs from "markdown-it-attrs";
import { parse } from "node-html-parser";
import Prism from "prismjs";
import { build } from "./build-common.js";


const md = new markdown({
    html: true,
    linkify: true,
    typographer: true,
    highlight: syntaxHighlight,
});
md.use(attrs);

function syntaxHighlight(string: string, lang: string): string {
    return Prism.highlight(string, Prism.languages[lang]!, lang);
}

function renderMarkdown(string: string, mode: "block" | "inline") {
    return md[mode === "block" ? "render" : "renderInline"](string);
}

function dedent(str: string) {
    str = str.replace(/^(\s*)\n/, "");
    const match = str.match(/^[^\S\r\n]+/);
    const unIndented = match ? str.replace(new RegExp("^" + match[0], "gm"), "") : str;
    // console.log("indented", str);
    // console.log("unindented", unIndented);
    return unIndented;
}

function markdownElement(html: HTMLElement) {
    const elsWithMarkdown = html.querySelectorAll("[markdown]");
    for (var el of elsWithMarkdown) {
        const html2 = dedent(el.innerHTML);
        if (parse(html2).querySelector("[markdown]")) throw new Error("nested [markdown] attributes are buggy af");
        el.innerHTML = renderMarkdown(html2, el.getAttribute("markdown") as any);
        el.removeAttribute("markdown");
    }
}

await build({
    splitting: true,
    minify: true,
    entrypoints: [
        "website/index.html",
    ],
    outdir: "./docs",
    naming: {
        entry: "[dir]/[name].[ext]",
        chunk: "[dir]/[hash].[ext]",
        asset: "[dir]/[hash].[ext]",
    },
    plugins: [
        {
            name: "HTML_PROCESS",
            setup(build) {
                build.onLoad({ filter: /\.html$/ }, async args => {
                    const html = await Bun.file(args.path).text();
                    const dom = parse(html);
                    markdownElement(dom as any);
                    return {
                        contents: dom.outerHTML,
                        loader: "html",
                    };
                });
            },
        }
    ],
});

console.log("Web Build OK");

