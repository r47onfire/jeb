import type { JebVM } from "./vm";

export const __initializers: ((x: JebVM) => void)[] = [];
export const __initializer = (f: (x: JebVM) => void) => {
    __initializers.push(f);
}
