import kaplay, { DrawTextOpt } from "kaplay";
import "kaplay/global";
import { parse } from "lib0/json";
import { min } from "lib0/math";
import { JebVM } from "../src";
import { Formatter } from "../src/format";

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
            const file = await files[0]!.getFile();
            openFile(file.name, await file.text());
        });
    }
});

onResize(() => {
    if (docEditing) refreshEditor(); else centerText();
});
onLoad(() => {
    centerText();
});

function openFile(name: string, text: string) {
    console.log({ name, text });
    try {
        loadDocumentAndStartEditing(parse(text));
    } catch (e: any) {
        mainText.text = `${name} is not valid JSON :(\n${e.stack ?? String(e)}`;
        centerText();
    }
}

function loadDocumentAndStartEditing(json: any) {
    docEditing = json;
    isEditing = true;
    refreshEditor();
}

const VM = new JebVM, FORMATTER = new class extends Formatter {
    escape(text: string) {
        return [...text].map(e => /[[\]\\]/.test(e) ? "\\" + e : e).join("");
    }
    highlight(s: string) {
        return `[h]${s}[/h]`
    }
    handleAtom(atom: any, selected: boolean, flag: string | null, parent: any, parentIndex: number, availableWidth: number) {
        const name = super.handleAtom(atom, selected, flag, parent, parentIndex, availableWidth);
        return flag === "define" ? this.#colorWrap(name, "red") : flag === "docstring" ? this.#colorWrap(name, "lime") : name;
    }
    #colorWrap(x: string, color: string) {
        return `[c=${color}]${x}[/c]`;
    }
}(VM);

function refreshEditor() {
    for (var i = 0; i < 2; i++) {
        const textOpts = centerText();
        FORMATTER.maxWidth = 0;
        while (formatText({ ...textOpts, text: "a".repeat(FORMATTER.maxWidth) }).width < AREA_WIDTH()) FORMATTER.maxWidth++;
        mainText.text = FORMATTER.format(docEditing, currentPath);
    }
}
function centerText() {
    mainText.pos = center();
    const textOpts: Omit<DrawTextOpt, "text"> = {
        size: mainText.textSize,
        styles: mainText.textStyles,
        transform: mainText.textTransform
    }
    mainText.width = min(AREA_WIDTH(), formatText({ ...textOpts, text: mainText.text }).width);
    return textOpts;
}
