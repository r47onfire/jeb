export interface Linked<T> {
    readonly value: T;
    readonly next: this | null;
}
interface LinkedListNode<T> extends Linked<T> {
    readonly lengthHere: number;
}
export type LinkedList<T> = LinkedListNode<T> | null;
export const llPush = <T>(top: LinkedList<T>, value: T): LinkedListNode<T> => {
    return { value: value, lengthHere: llLength(top) + 1, next: top };
}
export const llLength = (ll: LinkedList<any>): number => {
    return ll ? ll.lengthHere : 0;
}
export const llPop = <T extends Linked<any>>(ll: T): { value: T["value"]; rest: T | null; } => {
    return { value: ll.value, rest: ll.next };
}
export const llPopN = <T extends Linked<any>>(ll: T, popAmount: number): { values: T["value"][]; rest: T | null; } => {
    const out: T["value"][] = [];
    for (var i = 0; i < popAmount && ll; i++) {
        const { value, rest } = llPop(ll!);
        out.push(value);
        ll = rest as any;
    }
    return { values: out.reverse(), rest: ll };
}
export const llPushArray = <T>(ll: LinkedList<T>, moreValues: T[]): LinkedList<T> => {
    for (var i = 0; i < moreValues.length; i++) ll = llPush(ll, moreValues[i]!);
    return ll;
}
export const llToArray = <T extends Linked<any>>(ll: T | null): T["value"][] => {
    return ll ? llPopN(ll, Infinity).values : [];
}
