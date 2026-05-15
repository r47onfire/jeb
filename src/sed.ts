import { isArray, last } from "lib0/array";
import { keys } from "lib0/object";
import { type Draft } from "mutative";
import { Travels } from "travels";
import { Formatter, NonterminalPath } from "./format";
import { err, ok } from "./result";

/*

structural editor

navigation

* up nesting level
* down nesting level

* next item in nesting
* previous item in nesting

* atom snapping / auto-jump
    * maintains preferred depth value
    * when you jump left or right, if it's off the end, it jumps out until it's able to go to the right, and then jumps in until it hits an atom or reaches the same depth as before
    * when you jump in or out, it sets the preferred depth value

editing

* wrap current item in list
* wrap current item in object
* add item before or after
* delete current item
* move current item back/forward
* change atom type

* edit string
* edit number
* toggle boolean

* copy
* cut
* paste

* undo
* redo


*/

interface EditState {
    readonly doc: any,
    readonly focus: NonterminalPath,
    readonly onKey: boolean,
    readonly preferredHeight: number,
    readonly atomEdit: any,
    readonly editCursor: number,
}

function newEditState(
    doc: any,
    focus: NonterminalPath = [],
    onKey = false,
    preferredHeight = 0,
    atomEdit: any = null,
    editCursor = 0
): EditState {
    return {
        doc,
        focus,
        onKey,
        preferredHeight,
        atomEdit,
        editCursor
    };
}

type editCb = (state: Draft<EditState>, fail: (msg: string) => void) => boolean;

export class JEBEditor {
    #doc: Travels<EditState, true, false>;
    constructor(doc: any, public fmt: Formatter) {
        this.#doc = new Travels(
            newEditState(doc),
            {
                autoArchive: false, // allow "trivial" actions
                enableAutoFreeze: true,
                maxHistory: Number.MAX_VALUE,
            }
        );
    }
    #edit(commit: boolean, impl: editCb) {
        var result = ok(null);
        this.#doc.setState(draft => {
            if (!impl(draft, msg => result = err(msg)) && result.ok) result = err("you can't do that");
        });
        if (commit && result.ok) this.#doc.archive();
        return result;
    }
    render() {
        const { doc, focus, onKey } = this.#doc.getState();
        return this.fmt.format(doc, onKey ? [...focus, true] : focus);
    }
    goOut() {
        return this.#edit(false, (state, fail) => {
            const { focus } = state;
            if (focus.length > 0) {
                focus.pop();
                state.preferredHeight = focus.length;
                state.onKey = false;
                return true;
            } else {
                fail("at top level already");
                return false
            }
        });
    }
    goIn() {
        return this.#edit(false, in_);
    }
    goPrevNext(dir: 1 | -1, autojump = true) {
        return this.#edit(false, s(dir, autojump));
    }
}

function in_(state: Draft<EditState>, fail: (msg: string) => void, end = false, changePreferred = true) {
    const { doc, focus } = state;
    const item = getAtPath(doc, focus);
    const len = () => (isArray(item) ? item : keys(item)).length;
    if (typeof item !== "object" || len() === 0) {
        fail("can't go in");
        return false;
    } else {
        const i = (end ? len() - 1 : 0);
        focus.push(isArray(item) ? i : keys(item)[i]!);
        if (changePreferred) state.preferredHeight = focus.length;
        state.onKey = isArray(item) ? false : !end;
        return true;
    }
}

function s(dir: 1 | -1, autojump: boolean): editCb {
    return (state, fail) => {
        const { doc, focus, preferredHeight, onKey } = state;
        for (; ;) {
            if (focus.length === 0) break;
            const lastIndex = last(focus);
            const currentObject = getAtPath(doc, butlast(focus));
            if (isArray(currentObject)) {
                const newIndex = lastIndex as number + dir;
                if (newIndex < 0 || newIndex >= currentObject.length) {
                    if (autojump) {
                        focus.pop();
                        continue;
                    } else {
                        fail("at end of array");
                        return false;
                    }
                } else {
                    focus.pop();
                    focus.push(newIndex);
                    break;
                }
            } else {
                // On key: get off key
                // Off key: get on new key
                const k = keys(currentObject);
                const i = k.indexOf(lastIndex as string);
                if (onKey) {
                    if (dir < 0) {
                        if (i === 0) { // first key
                            if (autojump) {
                                focus.pop();
                                continue;
                            } else {
                                fail("at end of object");
                                return false;
                            }
                        } else {
                            focus.pop();
                            focus.push(k[i - 1]!);
                        }
                    }
                    state.onKey = false;
                    break;
                } else {
                    if (dir > 0) {
                        if (i >= (k.length - 1)) { // last key
                            if (autojump) {
                                focus.pop();
                                continue;
                            } else {
                                fail("at end of object");
                                return false;
                            }
                        } else {
                            focus.pop();
                            focus.push(k[i + 1]!);
                        }
                    }
                    state.onKey = true;
                    break;
                }
            }
        }
        while (autojump && focus.length < preferredHeight) {
            const moved = in_(state, () => { }, dir < 0, false);
            if (!moved) break;
        }
        return true;
    }
}

function getAtPath(obj: any, path: NonterminalPath) {
    for (var i = 0; i < path.length; i++) {
        obj = obj[path[i]!];
    }
    return obj;
}

function butlast<T>(a: T[]): T[] {
    return a.slice(0, -1);
}
