import kaplay from "kaplay";
import "kaplay/global";
import { isString } from "lib0/function";
import { parse } from "lib0/json";
import { min } from "lib0/math";
import { HasDocstring, JebVM } from "../src";
import { type Format, superprint } from "../src/superprint";

kaplay({
    pixelDensity: min(devicePixelRatio, 2),
    background: "black",
});

loadShader("invert", null, "vec4 frag(vec2 p,vec2 u,vec4 c,sampler2D t){return vec4(c.rgb,def_frag().a>.5?0.:1.);}");
loadShader("crispy", null, "vec4 frag(vec2 p,vec2 u,vec4 c,sampler2D t){return vec4(c.rgb,def_frag().a>.5?1.:0.);}");

const AREA_WIDTH = () => width() * 0.8;

const mainText = add([
    pos(),
    anchor("center"),
    color(CYAN),
    text("drop [h].json[/h] file to edit\nor [h]click[/h] to choose a file", {
        size: 16,
        lineSpacing: 4,
        width: 1,
        indentAll: true,
        transform: { shader: "crispy" },
        styles: {
            h: {
                shader: "invert",
            },
            c: (i, c, p) => ({ color: rgb(p), override: true })
        }
    }),
]);

const canvas = _k.app.canvas;

canvas.addEventListener("dragover", e => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const fileItems = [...dt.items].filter(item => item.kind === "file");
    if (fileItems.length > 0) {
        e.preventDefault();
        dt.dropEffect = fileItems.some((item) => /application\/json/.test(item.type)) ? "copy" : "none";
    }
});
canvas.addEventListener("drop", async e => {
    const dt = e.dataTransfer;
    if (!dt) return;
    if (dt && [...dt.items].some((item) => item.kind === "file")) {
        e.preventDefault();
        const items = [...dt.items].map(e => e.getAsFile());
        for (var item of items) {
            if (!item) continue;
            if (/application\/json/.test(item.type)) {
                openFile(item.name, await item.text());
                return;
            }
        }
    }
});

// MARK: editor state variables

var isEditing = false;
var docEditing: any = null;
var currentPath: any[] = [-1];

onMousePress(() => {
    if (!isEditing) {
        showOpenFilePicker({
            types: [{
                description: "JSON code",
                accept: {
                    "application/json": [".json"],
                },
            }],
            excludeAcceptAllOption: true,
            multiple: false,
        }).then(async files => {
            const file = await files[0].getFile();
            openFile(file.name, await file.text());
        });
    }
});

function openFile(name: string, text: string) {
    console.log({ name, text });
    try {
        loadDocumentAndStartEditing(parse(text));
    } catch (e: any) {
        mainText.text = `${name} is not valid JSON :(\n${e.stack ?? String(e)}`;
    }
}

function loadDocumentAndStartEditing(json: any) {
    docEditing = json;
    isEditing = true;
    refreshEditor();
}

const VM = new JebVM;

function meta(form: any[]): Format | null {
    const name = form[0];
    if (!name) return null;
    const { value, ok } = VM.globalEnv.get(name);
    if (!ok) return null;
    if (!(value instanceof HasDocstring)) return null;
    const headerForms = value.doc.headerData;
    var breakage: Format | null = null;
    for (var headerForm of headerForms) {
        if (headerForm.matches(form)) {
            const b = headerForm.breakage(form);
            if (isString(b)) {
                return b;
            }
            else if (!breakage) {
                breakage = b;
            }
        }
    }
    return breakage;
}

onUpdate(() => {
    mainText.pos = center();
    mainText.width = min(AREA_WIDTH(), formatText({
        text: mainText.text,
        size: mainText.textSize,
        styles: mainText.textStyles,
        transform: mainText.textTransform
    }).width)
});

function refreshEditor() {
    mainText.text = superprint(docEditing, highlight, currentPath, escapeBrackets, meta, 2, 100);
}

function escapeBrackets(text: string) {
    return text.replace(/(\\)?(.)/gm, (match, slash, value) => slash ? (/["nfrtvxuU\\]/.test(value) ? "\\" + match : match) : match.replace(/([[\]\\])/g, "\\$1")); // cSpell:ignore nfrtvxu
}

function highlight(s: string) {
    return `[h]${s}[/h]`
}