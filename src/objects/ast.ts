export type JEBCode =
    /** Look up a local variable named at that index in the symbol table. */
    ["local", nameIndex: number] | ["assign"];
