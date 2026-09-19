import { isinstance } from "@r47onfire/game-math";
import { stringify } from "lib0/json";
import { Fun } from "./callable";
import { Env } from "./env";
import { JEBError, wrapThrowToError } from "./errors";
import { AccessType, Reference } from "./protocol";
import { Identifier } from "./utils";
import { __initializer, JebVM } from "./vm";
import { ErrnoCode } from "./errno";

export class ObjectPropertyReference extends Reference {
    constructor(type: AccessType, public obj: any, public name: PropertyKey) { super(type); }
    get(vm: JebVM, shouldBind: boolean) {
        vm.emit("jeb:ffi/object/get", [this.name, this.obj]);
        var value = this.obj[this.name];
        if (shouldBind && typeof value === "function") value = value.bind(this.obj);
        return value;
    }
    set(vm: JebVM, value: any) {
        vm.emit("jeb:ffi/object/set", [this.name, this.obj, value]);
        wrapThrowToError(ErrnoCode.EJAVASCRIPT, () => {
            this.obj[this.name] = value;
        });
    }
}

export class VariableReference extends Reference {
    notFoundMessage: string;
    constructor(type: AccessType, public env: Env, public name: Identifier) {
        super(type);
        this.notFoundMessage = type === AccessType.PROPERTY ? `module has no property ${stringify(this.name)}` :
            `${type === AccessType.VARIABLE ? "variable" : "function"} ${stringify(this.name)} not found`;
    }
    get() {
        return this.env.get(this.name).else(() => this.#referenceError());
    }
    set(vm: JebVM, value: any, create: boolean, readonly: boolean) {
        if (create) {
            if (readonly) this.env.addConst(this.name, value);
            else this.env.add(this.name, value);
        } else {
            const didSet = this.env.set(this.name, value);
            if (didSet === undefined) {
                this.#referenceError();
            } else if (!didSet) {
                throw new JEBError(ErrnoCode.EROFS, `${stringify(this.name)} is a constant`);
            }
        }
        vm.getProtocol(true, false, "name", [value])?.run(vm, [value], { name: this.name });
    }
    #referenceError(): never {
        throw new JEBError(ErrnoCode.ENAME, this.notFoundMessage);
    }
}

__initializer(vm => {
    vm.addProtocol("name", {
        type: [[Fun]],
        run(vm, { 0: fun }, { name }) { fun.name ??= name; },
        doc: "",
    });
});
