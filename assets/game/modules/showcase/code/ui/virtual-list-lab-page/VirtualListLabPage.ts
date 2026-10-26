import { _decorator, Button, Label, Node, ScrollView } from 'cc';
import { VirtualList, type VirtualListLayout } from '../../../../../../framework/ui/components/virtual-list';
import type { BoundVirtualList } from '../../../../../../framework/ui/view-bindings';
import { State } from '../../../../../../framework/core/state';
import type { ViewShowContext } from '../../../../../../framework/ui/ui-view';
import {
    VirtualListItemPart,
    VirtualListDemoPulse,
    VirtualListBadges,
    virtualRowBadge,
    type VirtualListDemoRow,
} from '../../components/virtual-list-item-part/VirtualListItemPart';
import { Badge } from '../../../../../../framework/ui/components/badge/badge';
import { ShowcaseRes } from '../../../contracts/generated/resources-default';
import { VirtualListLabPageBinding } from './generated/VirtualListLabPageBinding';
const { ccclass } = _decorator;
/** 一万条业务数据的列表/网格示例，演示局部刷新、定位、订阅与异步清理。 */
@ccclass('showcase.VirtualListLabPage')
export class VirtualListLabPage extends VirtualListLabPageBinding {
    private list?: BoundVirtualList<VirtualListDemoRow>;
    private mode = 0;
    protected onShow(show: ViewShowContext<void, void>): void {
        const rows = Array.from({ length: 10000 }, (_, index) => ({
            id: index + 1,
            title: `条目 #${index + 1}`,
            revision: 0,
        }));
        this.mode = 0;
        this.ctx.badges.group(VirtualListBadges, 'sum', show.scope);
        const sources = rows
            .filter((row) => row.id % 100 === 1)
            .map((row) => this.ctx.badges.source(virtualRowBadge(row.id), show.scope, VirtualListBadges, 1));
        this.nodeBadge.getComponent(Badge)!.bind(this.ctx.badges, VirtualListBadges, show.scope);
        let pulse = 0;
        const scroll = this.nodeList.getComponent(ScrollView)!;
        const layout = (): VirtualListLayout<VirtualListDemoRow> => {
            const width = scroll.view!.width;
            return {
                axis: this.mode === 2 ? 'horizontal' : 'vertical',
                itemWidth: this.mode === 1 ? (width - 24) / 3 : this.mode === 2 ? Math.min(width, 320) : width,
                itemHeight: this.mode === 3 ? (row) => 88 + ((row.id + row.revision) % 4) * 32 : 88,
                columns: this.mode === 1 ? 3 : 1,
                spacingX: 12,
                spacingY: 8,
                overscanRows: 1,
            };
        };
        const component = this.nodeList.getComponent(VirtualList)!;
        const data = new State<readonly VirtualListDemoRow[]>(rows);
        const list = show.bindings.list(component, data.readonly, (state) => state, {
            prefab: ShowcaseRes.prefab.prefabsVirtualListItemPart,
            part: VirtualListItemPart,
            key: (row) => row.id,
            layout: layout(),
            bind: (part, item) => part.bind(item),
        });
        this.list = list;
        // 列表本身固定尺寸；示例页面在视口变化时明确重新计算三列的宽度。
        show.listen(scroll.view!.node, Node.EventType.SIZE_CHANGED, () => list.setLayout(layout()));
        const bind = (button: Button, action: () => void) => show.listen(button.node, Button.EventType.CLICK, action);
        bind(this.btnBack, () => show.ui.back());
        const modes = ['纵向列表', '固定网格', '横向列表', '变高列表'];
        this.btnMode.getComponentInChildren(Label)!.string = '切换布局';
        bind(this.btnMode, () => {
            this.mode = (this.mode + 1) % modes.length;
            list.setLayout(layout());
        });
        bind(this.btnJump, () => {
            if (list.count) list.scrollToIndex(Math.min(4999, list.count - 1), 'center', 0.25);
        });
        bind(this.btnTop, () => {
            if (list.count) list.scrollToIndex(0);
        });
        bind(this.btnData, () => data.set(list.count ? [] : rows));
        bind(this.btnRefresh, () => {
            const { start, end } = list.inspect().range;
            for (let index = start; index < end; index++) {
                rows[index] = { ...rows[index], revision: rows[index].revision + 1 };
            }
            data.set(rows);
        });
        bind(this.btnEvent, () => {
            this.ctx.events.emit(VirtualListDemoPulse, ++pulse);
            this.ctx.badges.batch(() => sources.forEach((source) => source.set(pulse % 2 ? 0 : 1)));
        });
    }
    protected onTick(): void {
        if (!this.list) return;
        const state = this.list.inspect();
        const window = state.count ? `${state.range.start + 1}–${state.range.end}` : '空';
        const mode = ['纵向', '网格', '横向', '变高'][this.mode];
        this.lblOutput.string = `${mode} · 数据 ${state.count} 条 · 实例 ${state.slots} 个\n窗口 ${window} · 待处理 ${state.pending}`;
    }
    protected onHide(): void {
        this.list = undefined;
    }
}
