import type { Lifetime } from '../../assets/framework/core/scope';
import type { ScopedAssets } from '../../assets/framework/assets/asset-manager';
import type { AssetKey } from '../../assets/framework/assets/asset-types';
import { GameComponent } from '../../assets/framework/components/game-component';
import type { PartContext } from '../../assets/framework/ui/part-presentation';
import type { VirtualList } from '../../assets/framework/ui/components/virtual-list';
import type { Node } from 'cc';
import type { ReadonlyState } from '../../assets/framework/core/state';
import type { ViewBindings } from '../../assets/framework/ui/view-bindings';

declare const list: VirtualList;
declare const owner: Lifetime;
declare const assets: ScopedAssets;
declare const prefab: AssetKey<'Prefab'>;
declare const bindings: ViewBindings;
declare const parent: Node;
declare const rows: ReadonlyState<readonly { id: number }[]>;
class RowPart extends GameComponent {
    bind(_item: PartContext<{ id: number }>): void {}
}
function contracts(): void {
    const handle = list.mount<{ id: number }, RowPart>({
        owner,
        assets,
        prefab,
        part: RowPart,
        key: (row) => row.id,
        layout: { itemWidth: 100, itemHeight: 20 },
        bind: (part, item) => {
            part.bind(item);
            // @ts-expect-error 借用期限不能关闭框架绑定。
            void item.scope.close();
            // @ts-expect-error 模型字段类型由数据源保留。
            const wrong: string = item.state.value.data.id;
            void wrong;
        },
    });
    handle.setItems([{ id: 1 }]);
    handle.updateItem(0, { id: 2 });
    // @ts-expect-error 不允许替换为错误的数据类型。
    handle.updateItem(0, { id: 'wrong' });
    // @ts-expect-error 定位模式为明确的字符串联合。
    handle.scrollToIndex(0, 'left');
    const options = {
        prefab,
        part: RowPart,
        key: (row: { id: number }) => row.id,
        bind: (part: RowPart, item: PartContext<{ id: number }>) => part.bind(item),
    };
    bindings.items(parent, rows, (value) => value, options);
    bindings.part(parent, rows, (value) => value[0], options);
    const bound = bindings.list(list, rows, (value) => value, {
        ...options,
        layout: { itemWidth: 100, itemHeight: 20 },
    });
    // @ts-expect-error 绑定列表的数据源唯一，不能绕过源状态直接修改。
    bound.setItems([{ id: 2 }]);
    // @ts-expect-error 绑定列表的数据源唯一，不能直接修改单条数据。
    bound.updateItem(0, { id: 2 });
    // @ts-expect-error Part 的纯数据和虚拟列表一样，必须保留数据类型。
    bindings.items(parent, rows, (value) => value, { ...options, key: (row: { id: string }) => row.id });
}
void contracts;
