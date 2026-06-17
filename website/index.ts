import kaplay, { DrawTextOpt } from "kaplay";
import "kaplay/global";
import { parse, stringify } from "lib0/json";
import { min } from "lib0/math";
import { JEBEditor, JebVM, KAPLAYFormatter, ok, Result } from "../src";

kaplay({
    pixelDensity: min(devicePixelRatio, 2),
    background: "black",
    buttons: {
        menu_open_close: {},
        menu_next_tab: {},
        menu_prev_tab: {},
        menu_up: {},
        menu_down: {},
        menu_select: {},

        edit_up_level: { keyboard: "up" },
        edit_down_level: { keyboard: "down" },
        edit_next_el: { keyboard: "right" },
        edit_prev_el: { keyboard: "left" },
        edit_toggle_pretty: { keyboard: "`" },

        edit_undo: {},
        edit_redo: {},

        edit_cut: {},
        edit_copy: {},
        edit_paste: {},

        edit_edit_atom: {},
        edit_change_atom_type: {},

        edit_move_forward: {},
        edit_move_back: {},
        edit_insert_after: {},
        edit_insert_before: {},
        edit_delete: {},
        edit_wrap_in_array: { keyboard: "[" },
        edit_wrap_in_object: {},
    }
});

loadShader("invert", null, "vec4 frag(vec2 p,vec2 u,vec4 c,sampler2D t){return vec4(c.rgb,def_frag().a>.5?0.:1.);}");
loadShader("crispy", null, "vec4 frag(vec2 p,vec2 u,vec4 c,sampler2D t){return vec4(c.rgb,def_frag().a>.5?1.:0.);}");

const AREA_WIDTH = () => width() * 0.8;

const mainText = add([
    pos(),
    anchor("center"),
    color(WHITE.darken(70)),
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
            nh: {
                shader: "crispy",
            },
            i: {
                skew: 20,
            },
            b: {
                opacity: 1.5,
            },
            ref: {
                color: rgb("orange"),
                override: true,
            },
            code: {
                color: WHITE,
                override: true,
            },
            p: {
                color: rgb("gray"),
                override: true,
            },
            c(_i, _c, p) {
                return {
                    color: rgb(p),
                    override: true,
                };
            }
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

// MARK: editor state

var EDITOR: JEBEditor | null = null;
import TEST_JSON from "../test.json";

onMousePress(() => {
    if (!EDITOR) {
        openFile("test.json", stringify(TEST_JSON));
        return;
        showOpenFilePicker({
            types: [{
                description: "JSON code",
                accept: {
                    "application/json": ".json",
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

onResize(() => {
    if (EDITOR) refreshEditor(); else centerText();
});
onLoad(() => {
    centerText();
});

const openFile = (name: string, text: string) => {
    try {
        loadDocumentAndStartEditing(parse(text));
    } catch (e: any) {
        mainText.text = `${name} is not valid JSON :(\n${e.stack ?? String(e)}`;
        centerText();
        console.error(e);
    }
}

const loadDocumentAndStartEditing = (json: any) => {
    EDITOR = new JEBEditor(json, FORMATTER);
    refreshEditor();
}

const VM = new JebVM, FORMATTER = new KAPLAYFormatter(VM, {
    highlight: { style: "h" },
    noHighlight: { style: "nh" },
    nil: { text: "nil", style: "c", param: "#5522ff" },
    number: { style: "c", param: "#ff55aa" },
    string: { style: "c", param: "#00aa44" },
    true: { text: "#t", style: "c", param: "#00ff00" },
    false: { text: "#f", style: "c", param: "#ff0000" },
    quoted: { style: "c", param: "#555555" },
    defmacro: { style: "c", param: "#5588ff" },
    defun: { style: "c", param: "#2255ff" },
    defvar: { style: "c", param: "#ffbb00" },
    border: { style: "p" },
    italic: { style: "i" },
    bold: { style: "b" },
    param: { style: "i" },
    reference: { style: "ref" },
    code: { style: "code" },
});

const refreshEditor = () => {
    for (var i = 0; i < 2; i++) {
        const textOpts = centerText();
        var w = 0;
        while (formatText({ ...textOpts, text: "a".repeat(w) }).width < AREA_WIDTH()) w++;
        FORMATTER.columns = w - 1;
        mainText.text = EDITOR!.render();
        console.log(compileStyledText(mainText.text).text);
    }
}
const centerText = () => {
    mainText.pos = center();
    const textOpts: Omit<DrawTextOpt, "text"> = {
        size: mainText.textSize,
        styles: mainText.textStyles,
        transform: mainText.textTransform
    }
    mainText.width = min(AREA_WIDTH(), formatText({ ...textOpts, text: mainText.text }).width);
    return textOpts;
}

const refreshed = (cb: () => Result<any>) => {
    return () => {
        if (!EDITOR) return;
        const res = cb();
        if (res.ok) refreshEditor();
        else debug.error(res.value);
    }
}
onButtonPress("edit_up_level", refreshed(() => EDITOR!.goOut()));
onButtonPress("edit_down_level", refreshed(() => EDITOR!.goIn()));
onButtonPress("edit_next_el", refreshed(() => EDITOR!.goPrevNext(1, true)));
onButtonPress("edit_prev_el", refreshed(() => EDITOR!.goPrevNext(-1, true)));
onButtonPress("edit_toggle_pretty", refreshed(() => ok(FORMATTER.prettySyntax = !FORMATTER.prettySyntax)));
onButtonPress("edit_wrap_in_array", refreshed(() => ok(EDITOR!.wrap(true))));
