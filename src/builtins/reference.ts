import { isinstance } from "@r47onfire/game-math";
import { stringify } from "lib0/json";
import { Fun } from "../callable";
import { Env } from "../env";
import { JEBRecursionError, JEBReferenceError, JEBTypeError, wrapThrowToError } from "../errors";
import { AccessType, Reference } from "../protocol";
import { JebVM } from "../vm";
import { NOTHING } from "./define";

export class ObjectPropertyReference extends Reference {
    constructor(type: AccessType, public obj: any, public name: PropertyKey) { super(type); }
    get(_vm: JebVM, shouldBind: boolean) {
        var value = this.obj[this.name];
        if (shouldBind && typeof value === "function") value = value.bind(this.obj);
        return value;
    }
    set(vm: JebVM, value: any) {
        wrapThrowToError(vm, JEBTypeError, () => {
            this.obj[this.name] = value;
        });
    }
}

export class VariableReference extends Reference {
    notFoundMessage: string;
    constructor(type: AccessType, public env: Env, public name: string) {
        super(type);
        this.notFoundMessage = type === AccessType.PROPERTY ? `module has no property ${stringify(this.name)}` :
            `${type === AccessType.VARIABLE ? "variable" : "function"} ${stringify(this.name)} not found`;
    }
    get(vm: JebVM) {
        return this.env.get(this.name).else(() => this.referenceError());
    }
    set(vm: JebVM, value: any, create: boolean, readonly: boolean) {
        if (create) {
            if (readonly) this.env.addConst(this.name, value);
            else this.env.add(this.name, value);
        } else {
            const didSet = this.env.set(this.name, value);
            if (didSet === undefined) {
                this.referenceError();
            } else if (!didSet) {
                throw new JEBTypeError(`${stringify(this.name)} is a constant`);
            }
        }
        if (isinstance(value, Fun)) value.name ??= this.name;
    }
    protected referenceError(): never {
        throw new JEBReferenceError(this.notFoundMessage);
    }
}
