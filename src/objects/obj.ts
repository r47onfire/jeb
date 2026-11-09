import { JEBDictionary } from "./dict";

/** Every object in JEB is an instance of this. */
export class JEBObject {
    /**
     * Number = immutable + this is the hash; null = mutable; undefined = not
     * computed yet
     */
    hash: number | null | undefined;
    constructor(
        public cls: JEBClass,
        public props: JEBDictionary,
    ) {}
}

/** Something that returns a new object when constructed. */
export class JEBClass extends JEBObject {
    constructor(
        public name: string,
        public mro: JEBClass[],
        cls: JEBClass,
        props: JEBDictionary,
    ) {
        super(cls, props);
    }
}

const build = <T extends string>(
    parentMapping: Record<T, { mro: T[]; cls: T }>,
): Record<T, JEBClass> => {
    const names = Reflect.ownKeys(parentMapping) as T[];
    const out: Record<T, JEBClass> = {} as any;
    for (var name of names) {
        out[name] = new JEBClass(name, [], null as any, null);
    }
    for (var name of names) {
        out[name].mro = parentMapping[name].mro.map((name) => out[name]);
        out[name].cls = out[parentMapping[name].cls];
    }
    return out;
};

const { object, type } = build({
    object: { mro: ["object"], cls: "type" },
    type: { mro: ["type", "object"], cls: "type" },
});
