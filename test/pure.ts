import * as babel from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";

export function extRefs(fn: Function) {

    const externalReferences = new Set();

    traverse(babel.parse(fn.toString()), {
        Identifier(path) {
            const name = path.node.name;
            if (!path.scope.hasBinding(name) && !(name in globalThis) && isWriteTarget(path)) {
                externalReferences.add(name);
            }
        },

    });

    return externalReferences;
}

function isWriteTarget(path: NodePath) {
    var current = path;
    for (var current = path, parent = current.parent; parent; parent = current.parent) {

        if (t.isAssignmentExpression(parent) && parent.left === current.node) {
            return true;
        }
        if (t.isUpdateExpression(parent)) {
            return true;
        }
        if (t.isMemberExpression(parent) && parent.object === current.node) {
            current = current.parentPath;
            continue;
        }
        current = current.parent as NodePath;
    }
    return false;
}
