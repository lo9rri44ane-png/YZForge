import { invariant } from '../../../core/errors';

/** 纵向固定网格、纵向变高列表或横向固定单行；尺寸由数据显式决定。 */
export interface VirtualListLayout<T = unknown> {
    /** 滚动方向，默认 vertical；horizontal 只支持固定尺寸单行。 */
    readonly axis?: 'vertical' | 'horizontal';
    /** 条目宽度，单位为 UI 坐标，必须大于 0；不会自动拉伸。 */
    readonly itemWidth: number;
    /** 正高度，或纵向单列的同步纯函数；整表更新、布局更新时重算，滚动时不调用。 */
    readonly itemHeight: number | ((data: T, index: number) => number);
    /** 固定列数，默认 1；必须为正整数。 */
    readonly columns?: number;
    /** 列间距，默认 0，不能为负。 */
    readonly spacingX?: number;
    /** 行间距，默认 0，不能为负。 */
    readonly spacingY?: number;
    /** 内容左边距，默认 0。 */
    readonly paddingLeft?: number;
    /** 内容右边距，默认 0。 */
    readonly paddingRight?: number;
    /** 内容上边距，默认 0。 */
    readonly paddingTop?: number;
    /** 内容下边距，默认 0。 */
    readonly paddingBottom?: number;
    /** 滚动方向两端各预备的行/条目数，默认 1，必须为非负整数。 */
    readonly overscanRows?: number;
}

/** 滚动定位方式：起点、居中、终点，或仅在条目未完整可见时移动最短距离。 */
export type VirtualListAlignment = 'start' | 'center' | 'end' | 'nearest';

/** 左闭右开的条目索引区间；空区间的 start 与 end 都为 0。 */
export interface VirtualListRange {
    /** 第一个需要实例的索引。 */
    readonly start: number;
    /** 最后一个需要实例的索引加一。 */
    readonly end: number;
}

/** @internal 几何快照；变高列表构建 O(n)，窗口和定位查询 O(log n)，不访问引擎。 */
export class VirtualLayout<T = unknown> {
    readonly options: Required<VirtualListLayout<T>>;
    private readonly starts: number[] = [];
    private readonly heights: number[] = [];
    private minimum = Infinity;
    constructor(input: VirtualListLayout<T>, items: readonly T[] = []) {
        this.options = Object.freeze({
            axis: input.axis ?? 'vertical',
            itemWidth: input.itemWidth,
            itemHeight: input.itemHeight,
            columns: input.columns ?? 1,
            spacingX: input.spacingX ?? 0,
            spacingY: input.spacingY ?? 0,
            paddingLeft: input.paddingLeft ?? 0,
            paddingRight: input.paddingRight ?? 0,
            paddingTop: input.paddingTop ?? 0,
            paddingBottom: input.paddingBottom ?? 0,
            overscanRows: input.overscanRows ?? 1,
        });
        for (const [key, value] of Object.entries(this.options)) {
            if (key === 'axis' || (key === 'itemHeight' && typeof value === 'function')) continue;
            invariant(
                typeof value === 'number' && Number.isFinite(value) && value >= 0,
                'VIRTUAL_LIST_LAYOUT',
                `${key} 必须为有限非负数`,
            );
        }
        const o = this.options;
        invariant(o.axis === 'vertical' || o.axis === 'horizontal', 'VIRTUAL_LIST_LAYOUT', '未知滚动方向');
        invariant(
            o.itemWidth > 0 && (typeof o.itemHeight === 'function' || o.itemHeight > 0),
            'VIRTUAL_LIST_LAYOUT',
            '条目尺寸必须大于 0',
        );
        invariant(Number.isInteger(o.columns) && o.columns > 0, 'VIRTUAL_LIST_LAYOUT', '列数必须为正整数');
        invariant(Number.isInteger(o.overscanRows), 'VIRTUAL_LIST_LAYOUT', '预备行数必须为整数');
        invariant(
            o.axis !== 'horizontal' || (o.columns === 1 && typeof o.itemHeight === 'number'),
            'VIRTUAL_LIST_LAYOUT',
            '横向只支持固定尺寸单行',
        );
        invariant(
            typeof o.itemHeight !== 'function' || o.columns === 1,
            'VIRTUAL_LIST_LAYOUT',
            '变高列表只支持纵向单列',
        );
        if (typeof o.itemHeight === 'function') {
            let next = o.paddingTop;
            for (let index = 0; index < items.length; index++) {
                const height = o.itemHeight(items[index], index);
                invariant(
                    Number.isFinite(height) && height > 0,
                    'VIRTUAL_LIST_LAYOUT',
                    `条目 ${index} 的高度必须为有限正数`,
                );
                this.starts.push(next);
                this.heights.push(height);
                this.minimum = Math.min(this.minimum, height);
                next += height + o.spacingY;
                invariant(Number.isFinite(next), 'VIRTUAL_LIST_LAYOUT', '累计高度超过有效范围');
            }
        }
    }
    get horizontal(): boolean {
        return this.options.axis === 'horizontal';
    }
    get variable(): boolean {
        return typeof this.options.itemHeight === 'function';
    }
    get stride(): number {
        return this.horizontal
            ? this.options.itemWidth + this.options.spacingX
            : (typeof this.options.itemHeight === 'number' ? this.options.itemHeight : this.minimum) +
                  this.options.spacingY;
    }
    get width(): number {
        const o = this.options;
        return o.paddingLeft + o.paddingRight + o.columns * o.itemWidth + (o.columns - 1) * o.spacingX;
    }
    height(count: number): number {
        if (this.horizontal) return this.options.paddingTop + this.options.paddingBottom + this.itemHeight(0);
        if (this.variable)
            return count
                ? this.starts[count - 1] + this.heights[count - 1] + this.options.paddingBottom
                : this.options.paddingTop + this.options.paddingBottom;
        const rows = Math.ceil(count / this.options.columns);
        return (
            this.options.paddingTop +
            this.options.paddingBottom +
            Math.max(0, rows * this.stride - this.options.spacingY)
        );
    }
    /** 非滚动轴的必需尺寸。 */
    get crossSize(): number {
        return this.horizontal ? this.height(0) : this.width;
    }
    extent(count: number): number {
        return this.horizontal
            ? this.options.paddingLeft +
                  this.options.paddingRight +
                  Math.max(0, count * this.stride - this.options.spacingX)
            : this.height(count);
    }
    itemHeight(index: number): number {
        return typeof this.options.itemHeight === 'number' ? this.options.itemHeight : this.heights[index];
    }
    clampOffset(count: number, viewport: number, offset: number): number {
        return Math.max(0, Math.min(offset, Math.max(0, this.extent(count) - viewport)));
    }
    range(count: number, viewport: number, offset: number): VirtualListRange {
        if (!count || viewport <= 0) return { start: 0, end: 0 };
        const o = this.options;
        const current = this.clampOffset(count, viewport, offset);
        if (this.variable) {
            const first = Math.max(
                0,
                this.lowerBound(count, (index) => this.starts[index] + this.heights[index] > current) - o.overscanRows,
            );
            const end = Math.min(
                count,
                this.lowerBound(count, (index) => this.starts[index] >= current + viewport) + o.overscanRows,
            );
            return end > first ? { start: first, end } : { start: 0, end: 0 };
        }
        const top = current - (this.horizontal ? o.paddingLeft : o.paddingTop);
        const rows = Math.ceil(count / o.columns);
        const size = this.horizontal ? o.itemWidth : this.itemHeight(0);
        const first = Math.max(0, Math.floor((top - size) / this.stride) + 1 - o.overscanRows);
        const end = Math.min(rows, Math.ceil((top + viewport) / this.stride) + o.overscanRows);
        if (end <= first) return { start: 0, end: 0 };
        return { start: first * o.columns, end: Math.min(count, end * o.columns) };
    }
    capacity(count: number, viewport: number): number {
        if (viewport <= 0) return 0;
        return Math.min(
            count,
            (Math.ceil(viewport / this.stride) + 1 + this.options.overscanRows * 2) * this.options.columns,
        );
    }
    position(index: number): { x: number; y: number } {
        const o = this.options;
        if (this.horizontal) return { x: o.paddingLeft + index * this.stride, y: o.paddingTop };
        if (this.variable) return { x: o.paddingLeft, y: this.starts[index] };
        return {
            x: o.paddingLeft + (index % o.columns) * (o.itemWidth + o.spacingX),
            y: o.paddingTop + Math.floor(index / o.columns) * this.stride,
        };
    }
    offset(count: number, viewport: number, index: number, alignment: VirtualListAlignment, current: number): number {
        const top = this.horizontal ? this.position(index).x : this.position(index).y;
        const bottom = top + (this.horizontal ? this.options.itemWidth : this.itemHeight(index));
        let target = top;
        if (alignment === 'center') target = (top + bottom - viewport) / 2;
        else if (alignment === 'end') target = bottom - viewport;
        else if (alignment === 'nearest') {
            if (top >= current && bottom <= current + viewport) target = current;
            else if (top <= current && bottom >= current + viewport) target = current;
            else target = top < current ? top : bottom - viewport;
        }
        return this.clampOffset(count, viewport, target);
    }
    private lowerBound(count: number, predicate: (index: number) => boolean): number {
        let low = 0,
            high = count;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (predicate(middle)) high = middle;
            else low = middle + 1;
        }
        return low;
    }
}
