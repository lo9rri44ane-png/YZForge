import type { Node } from 'cc';
import type { Lifetime } from '../core/scope';

const guards = new WeakMap<Node, () => boolean>();

/** @internal 准备区域在父页面恢复原生事件时仍禁止受管输入。 */
export function guardUIInput(node: Node, owner: Lifetime, allowed: () => boolean): void {
    guards.set(node, allowed);
    owner.signal.onAbort(() => {
        if (guards.get(node) === allowed) guards.delete(node);
    });
}

/** @internal 原生事件与语义事件共用显示检查。 */
export function acceptsUIInput(node: Node): boolean {
    if (!node.activeInHierarchy) return false;
    for (let current: Node | null = node; current; current = current.parent)
        if (guards.get(current)?.() === false) return false;
    return true;
}
