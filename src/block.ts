import { Env } from "./env";

/**
 * A chunk of code that will be deferred evaluation, like an implicit lambda
 */
export class Block {
    constructor(public closureEnv: Env, public body: any[]) {}
}
