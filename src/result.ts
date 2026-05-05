export interface Result<T> {
    ok: boolean;
    value: T;
}
export function ok<T>(value: T): Result<T> {
    return { ok: true, value };
}
export function err(message: string): Result<any> {
    return { ok: false, value: message };
}
