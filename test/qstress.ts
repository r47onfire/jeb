import { JebVM } from "../src"

const vm = new JebVM();
vm.start(["begin",
    ["define", ["memoize", "f"],
        ["let", [["cache", {}]],
            ["fn", ["a"],
                ["let", [["cached", ["index", ["local", "cache"], ["local", "a"]]]],
                    ["if", ["isNil", ["local", "cached"]],
                        ["set", ["index", ["local", "cache"], ["local", "a"]], ["f", ["local", "a"]]],
                        ["local", "cached"]]]]]],
    ["define", "q", ["memoize", ["fn", ["a"],
        ["if", ["less", ["local", "a"], 3],
            1,
            ["add",
                ["q", ["sub", ["local", "a"], ["q", ["sub", ["local", "a"], 1]]]],
                ["q", ["sub", ["local", "a"], ["q", ["sub", ["local", "a"], 2]]]]]]]]],
    ["q", 5000n]
]);
while (vm.step());
