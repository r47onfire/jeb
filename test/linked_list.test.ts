import { expect, test } from "bun:test";
import { LinkedList, llPopN, llPushArray } from "../src";

test("linked list from array to array roundtrips", () => {
    expect(llPopN(llPushArray(null, [1, 2, 3]), Infinity).values).toEqual([1, 2, 3]);
});

test("linked list from array to array roundtrips", () => {
    var list: LinkedList<number> = llPushArray(null, [1, 2, 3]);
    expect(list).not.toBeNull();
    expect(list!.value).toEqual(1);
});
