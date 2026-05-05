import { HasDocstring } from "./doc";
import { Env } from "./env";
import { JebVM } from "./vm";

export class BuiltinFunction extends HasDocstring {
    constructor(
        public readonly name: string,
        public readonly arity: { min: number; max: number; } | number | null,
        public readonly isSpecial: boolean,
        public readonly resultIsMacro: boolean,
        public readonly impl: (args: any[], vm: JebVM) => any,
        doc: string,
    ) { super(doc); }
}

export class Lambda extends HasDocstring {
    constructor(
        public readonly isMacro: boolean,
        public readonly lastIsSpread: boolean,
        public name: string | undefined,
        public readonly params: string[],
        public readonly body: any,
        public readonly closureEnv: Env,
        doc: string,
    ) { super(doc); }
}
