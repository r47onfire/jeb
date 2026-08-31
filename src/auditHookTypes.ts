export interface JEBAuditEvents {
    [x: string]: unknown[];
    // potentially unsafe things
    "jeb:add_audit_hook": [];
    "jeb:ffi/call_function": [f: Function, args: any[]];
    "jeb:ffi/object/get": [o: any, key: PropertyKey];
    "jeb:ffi/object/set": [o: any, key: PropertyKey, value: any];
    // "jeb:ffi/object/del": [o: any, key: PropertyKey];
    "jeb:loop_check": [repeatCount: number];
}

export type JEBAuditEvent<T extends keyof JEBAuditEvents> = [T, ...JEBAuditEvents[T]];

export const makeSingleEventWatcher = <T extends keyof JEBAuditEvents>(event: T, cb: (...args: JEBAuditEvents[T]) => void) => {
    return (name: keyof JEBAuditEvents, ...args: unknown[]) => name === event && cb(...args);
}
