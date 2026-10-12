import { invariant } from './errors';

const writers = new WeakMap<object, Map<PropertyKey, object>>();
/** @internal 为受管绑定独占目标属性；调用者在停止写入和恢复原值后同步释放。 */
export function claimProperties(target: object, keys: readonly PropertyKey[]): () => void {
    const slots = writers.get(target) ?? new Map<PropertyKey, object>();
    for (const key of keys)
        invariant(!slots.has(key), 'BINDING_PROPERTY_OWNED', `Property already has a managed writer: ${String(key)}`);
    const token = {};
    for (const key of keys) slots.set(key, token);
    writers.set(target, slots);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        for (const key of keys) if (slots.get(key) === token) slots.delete(key);
        if (!slots.size) writers.delete(target);
    };
}
