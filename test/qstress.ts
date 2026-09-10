import { JebVM } from "../src"

const vm = new JebVM();
vm.start(["begin",
    ["define", ["memoize", "f"],
        ["let", [["cache", {}]],
            ["fn", ["a"],
                ["let", [["cached", [".", ["$", "cache"], ["$", "a"]]]],
                    ["if", ["nil?", ["$", "cached"]],
                        ["set", [".", ["$", "cache"], ["$", "a"]], ["f", ["$", "a"]]],
                        ["$", "cached"]]]]]],
    ["define", "q", ["memoize", ["fn", ["a"],
        ["if", ["<", ["$", "a"], 3],
            1,
            ["+",
                ["q", ["-", ["$", "a"], ["q", ["-", ["$", "a"], 1]]]],
                ["q", ["-", ["$", "a"], ["q", ["-", ["$", "a"], 2]]]]]]]]],
    ["q", 5000n]
]);
while (vm.step());
