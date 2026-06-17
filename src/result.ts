/**
 * Burritos!
 */
export interface Result<T> {
    ok: boolean;
    value: T;
}
export const ok = <T>(value: T): Result<T> => {
    return { ok: true, value };
}
export const err = (message: string): Result<any> => {
    return { ok: false, value: message };
}
