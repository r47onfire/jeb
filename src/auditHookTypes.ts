export interface JEBAuditEvents {
    [x: string]: unknown;
    // potentially unsafe things
    "jeb:add_audit_hook": void;
    "jeb:ffi/call_function": [f: Function, args: any[]];
    "jeb:ffi/object/get": [key: PropertyKey, o: any];
    "jeb:ffi/object/set": [key: PropertyKey, o: any, value: any];
    // "jeb:ffi/object/del": [key: PropertyKey, o: any];
    "jeb:loop_check": number;
}
