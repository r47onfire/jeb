import { expect, test } from "bun:test";
import { LinkedList, llPushArray, llToArray } from "../src";

test("linked list from array to array roundtrips", () => {
    var list: LinkedList<number> = llPushArray(null, [1, 2, 3]);
    expect(list).not.toBeNull();
    expect(list!.value).toEqual(1);
    var arr = llToArray(list);
    expect(arr).toEqual([1, 2, 3]);
});
