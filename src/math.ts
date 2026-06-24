
/**
 * A function taking two arguments
 */
export type BinaryFun = (a: any, b: any) => any;

const int = BigInt, float = Number, isInt = float.isInteger, isSafeInt = float.isSafeInteger, isGoodInt = (x: number) => isInt(x) && isSafeInt(x);
export { float };
/**
 * Wraps a numeric function to automatically work with both numbers and bigints and automatically upcast
 * or downcast as needed to keep precision okay (divsion needs to be handled separately; bigint/bigint will still round)
 * @param cb The function that will be called as either `(a: number, b: number) => number` or `(a: bigint, b: bigint) => bigint` (the types are all `any` due to typescript shenanigans)
 * @returns the wrapped function that can be called with any number or bigint combination
 */
export function numberOp(cb: BinaryFun): (a: number | bigint, b: number | bigint) => number | bigint {
    return (x, y) => {
        // Why is doing math on two bigints / numbers so complicated
        const bigX = typeof x === "bigint", bigY = typeof y === "bigint";
        if (bigX && bigY) {
            return cb(x, y);
        }
        else if (!bigX && !bigY) {
            const naive = cb(x, y);
            return !isInt(naive) || isSafeInt(naive) ? naive : cb(int(x), int(y));
        }
        else if (bigX && !bigY) {
            // x is big, y is not
            return isGoodInt(y) ? cb(x, int(y)) : cb(float(x), y);
        }
        else if (!bigX && bigY) {
            // y is big, x is not
            return isGoodInt(x) ? cb(int(x), y) : cb(x, float(y));
        }
    };
}
