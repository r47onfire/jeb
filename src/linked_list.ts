/** Generic immutable linked stack or queue node (no length tracking) */
export interface Linked<T> {
    readonly value: T;
    readonly next: this | null;
}
/** Generic immutable linked list node (with length tracking) */
export interface LinkedListNode<T> extends Linked<T> {
    readonly lengthHere: number;
}
/** Immutable linked list, including `null` which is the empty list */
export type LinkedList<T> = LinkedListNode<T> | null;
/** Returns a new linked list with the value added to the top */
export const llPush = <T>(top: LinkedList<T>, value: T): LinkedListNode<T> => {
    return { value: value, lengthHere: llLength(top) + 1, next: top };
}
/**
 * Returns the length of the linked list quickly (since linked list
 * nodes know their own length by way of being immutable)
 */
export const llLength = (ll: LinkedList<any>): number => {
    return ll ? ll.lengthHere : 0;
}
/**
 * Takes the top item off the linked list, and returns the item as well as the rest of the list
 * @returns an object with value = the top item value, and rest = the 2nd and subsequent items list
 */
export const llPop = <T extends Linked<any>>(ll: T): { value: T["value"]; rest: T | null; } => {
    return { value: ll.value, rest: ll.next };
}
/**
 * Pops N items off the linked list and returns them in an array, as well as the rest of the linked list.
 * If the list is shorter than the requested amount, the returned array will have all the items, and the rest will be null.
 * @param popAmount number of items to pop
 * @returns an object with values = the array of values, and rest = the 2nd and subsequent items list
 */
export const llPopN = <T extends Linked<any>>(ll: T | null, popAmount: number): { values: T["value"][]; rest: T | null; } => {
    const out: T["value"][] = [];
    for (; popAmount > 0 && ll; popAmount--) {
        const { value, rest } = llPop(ll!);
        out.push(value);
        ll = rest as any;
    }
    return { values: out, rest: ll };
}
/**
 * Prepends the new items to the list in reverse order, so that the first item of the array is the new first item of the linked list, and returns the new linked list.
 * @example
 * ```js
 * // Convert the array to a linked list by pushing it to null:
 * const linkedArray = llPushArray(null, [1, 2, 3]);
 * // linkedArray == {data: 1, next: {data: 2, next: {data: 3, next: null}}};
 */
export const llPushArray = <T>(ll: LinkedList<T>, moreValues: T[]): LinkedList<T> => {
    for (var i = moreValues.length - 1; i >= 0; i--) ll = llPush(ll, moreValues[i]!);
    return ll;
}
