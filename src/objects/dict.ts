import {
    AVLNode,
    AVLTree,
    AVLTree_get,
    AVLTree_set,
    compareNumbers,
} from "@r47onfire/game-math";
import { JEBObject } from "./obj";

export type JEBDictionary = AVLTree<
    number,
    readonly (readonly [key: JEBObject, value: JEBObject])[]
>;

export const dictSet = (
    dict: JEBDictionary,
    key: JEBObject,
    value: JEBObject,
) => {
    if (key.hash === null)
        throw new Error("can't insert object with null hash to dict");
    const bucket = AVLTree_get(dict, key.hash!, compareNumbers)?.value ?? [];
    for (var i = 0, len = bucket.length; i < len; i++) {
        const entry = bucket[i]!;
        if (equalObjects(entry[0], key)) {
            return AVLTree_set<NonNullable<JEBDictionary>>(
                dict,
                key.hash!,
                bucket.toSpliced(i, 1, [entry[0], value]),
                AVLNode,
                compareNumbers,
            );
        }
    }
    return AVLTree_set<NonNullable<JEBDictionary>>(
        dict,
        key.hash!,
        [...bucket, [key, value]],
        AVLNode,
        compareNumbers,
    );
};

export const dictGet = (dict: JEBDictionary, key: JEBObject) => {
    if (key.hash === null)
        throw new Error("can't use object with null hash as key");
    const bucket = AVLTree_get(dict, key.hash!, compareNumbers)?.value;
    if (!bucket) return;
    for (var i = 0, len = bucket.length; i < len; i++) {
        const { 0: k2, 1: value } = bucket[i]!;
        if (equalObjects(k2, key)) return value;
    }
};

// TODO: dictSet, dictRemove

export const equalObjects = (a: JEBObject, b: JEBObject): boolean => {
    if (a.hash !== b.hash) return false; // Definitely not equal
    if (a === b) return true; // Definitely the same object
    if (!equalObjects(a.cls, b.cls)) return false; // Different classes
    return equalDictionaries(a.props, b.props); // Different members
};

/** Counts the entries in a dictionary, across every hash bucket. */
const dictionarySize = (tree: JEBDictionary): number => {
    if (tree === null) return 0;
    return (
        tree.value.length +
        dictionarySize(tree.left) +
        dictionarySize(tree.right)
    );
};

/** True if every key in `a` is found in `b`, paired with an equal value. */
const dictionaryEntriesIn = (a: JEBDictionary, b: JEBDictionary): boolean => {
    if (a === null) return true;
    for (var pair = a.value, i = 0, len = pair.length; i < len; i++) {
        const { 0: key, 1: value } = pair[i]!;
        const bucket = AVLTree_get(b, key.hash!, compareNumbers)?.value;
        if (!bucket) return false; // No keys with this hash in b
        const match = bucket.find(({ 0: k }) => equalObjects(k, key));
        if (!match) return false; // Key not in b
        if (!equalObjects(match[1], value)) return false; // Values differ
    }
    return dictionaryEntriesIn(a.left, b) && dictionaryEntriesIn(a.right, b);
};

const equalDictionaries = (a: JEBDictionary, b: JEBDictionary): boolean => {
    if (a === null || b === null) return a === b; // One or both empty
    if (dictionarySize(a) !== dictionarySize(b)) return false; // Different sizes
    return dictionaryEntriesIn(a, b);
};
