import {
    _decorator,
    Node,
    Graphics,
    Label,
    UITransform,
    EventTouch,
    Vec3,
    Color,
    EditBox,
    sys,
    tween,
    Tween,
    UIOpacity,
} from 'cc';
import { GameComponent } from '../../../framework/components/game-component';
import {
    analyzePuzzle,
    autoCrossCompletedLines,
    generatePuzzle,
    getClues,
    getCompletedClues,
    type Difficulty,
} from './NonogramLogic';

const { ccclass } = _decorator;
type Snapshot = number[];
const INK = '#354c53';

/** 无预制体依赖的竖屏数织；所有监听随所属节点销毁。 */
@ccclass('NonogramDemo')
export class NonogramDemo extends GameComponent {
    private root!: Node;
    private board!: Node;
    private graphics!: Graphics;
    private clues!: Node;
    private status!: Label;
    private clock!: Label;
    private modeLabel!: Label;
    private editorLabel!: Label;
    private input!: EditBox;
    private size = 5;
    private solution: number[] = [];
    private cells: number[] = [];
    private undo: Snapshot[] = [];
    private redo: Snapshot[] = [];
    private editing = false;
    private draft: { size: number; solution: number[] } | null = null;
    private cross = false;
    private elapsed = 0;
    private won = false;
    private victory: Node | null = null;
    private assisted = false;
    private touchId: number | null = null;
    private before: Snapshot | null = null;
    private strokeValue = 1;
    private last = -1;
    private visited = new Set<number>();
    private message = '按左侧 / 上方数字填色，连续数字之间至少空一格';

    protected onInit(): void {
        this.node.once(Node.EventType.NODE_DESTROYED, this.clearVictory, this);
        this.root = this.box(this.node, 'NonogramUI', 0, 0, 720, 1280);
        this.paint(this.root, 720, 1280, '#697dcc');
        this.text(this.root, 'NONOGRAM · 数织花园', 0, 578, 660, 54, 34, '#fff4c9');
        this.button('★ 无限练习', -175, 519, 270, () => this.notify('免费练习 · 提示不限次数（答案辅助）'), '#dcb86b');
        this.clock = this.text(this.root, '', 170, 519, 280, 48, 25, '#fff2c1');
        (['easy', 'normal', 'hard'] as Difficulty[]).forEach((d, i) => {
            this.button(['5×5 入门', '10×10 进阶', '15×15 挑战'][i], -220 + 220 * i, 454, 204, () => this.newGame(d));
        });
        this.button('新关', -240, 389, 144, () => this.newGame(this.difficulty()));
        this.button('重开', -80, 389, 144, () => this.restart());
        this.button('撤销', 80, 389, 144, () => this.history(false));
        this.button('重做', 240, 389, 144, () => this.history(true));
        this.text(this.root, '上方为列提示 · 左侧为行提示 · 每五格加粗', 0, 333, 680, 35, 21, '#f4e5bd');
        this.clues = this.box(this.root, 'Clues', 0, 0, 720, 1280);
        this.board = this.box(this.root, 'Board', 55, -42, 510, 510);
        this.graphics = this.board.addComponent(Graphics);
        this.board.on(Node.EventType.TOUCH_START, this.begin, this);
        this.board.on(Node.EventType.TOUCH_MOVE, this.move, this);
        this.board.on(Node.EventType.TOUCH_END, this.end, this);
        this.board.on(Node.EventType.TOUCH_CANCEL, this.end, this);
        this.modeLabel = this.button(
            '■ 填涂',
            -220,
            -349,
            200,
            () => {
                this.cross = false;
                this.refresh();
            },
            '#bb895b',
        );
        this.button(
            '× 标空',
            0,
            -349,
            200,
            () => {
                this.cross = true;
                this.refresh();
            },
            '#bb895b',
        );
        this.button('提示', 220, -349, 200, () => this.hint(), '#dcb86b');
        this.status = this.text(this.root, '', 0, -409, 672, 64, 22, '#fff1c8');
        this.editorLabel = this.button('编辑答案', -220, -473, 200, () => this.toggleEditor());
        this.button('验证', 0, -473, 200, () => this.validate());
        this.button('试玩 / 返回', 220, -473, 200, () => this.tryDraft());
        const inputNode = this.box(this.root, 'NativeJSONInput', -75, -545, 510, 58);
        this.paint(this.box(inputNode, 'Background', 0, 0, 510, 58), 510, 58, '#f7edcf');
        const valueNode = this.box(inputNode, 'Text', 0, 0, 490, 54);
        const valueLabel = valueNode.addComponent(Label);
        valueLabel.fontSize = 16;
        valueLabel.lineHeight = 20;
        valueLabel.color = new Color().fromHEX(INK);
        this.input = inputNode.addComponent(EditBox);
        this.input.textLabel = valueLabel;
        if (this.input.placeholderLabel) this.input.placeholderLabel.string = '';
        this.input.maxLength = 10000;
        this.input.inputMode = EditBox.InputMode.ANY;
        this.button('导出', 267, -527, 112, () => this.exportJSON());
        this.button('导入', 267, -584, 112, () => this.importJSON());
        this.text(
            this.root,
            'JSON文本框：粘贴后点导入 · 编辑时尺寸按钮创建空白答案',
            -73,
            -604,
            520,
            35,
            16,
            '#e4dbfa',
        );
        this.newGame('easy');
        this.restore();
        this.fit();
    }

    protected onTick(dt: number): void {
        this.fit();
        if (!this.editing && !this.won) this.elapsed += dt;
        const seconds = Math.floor(this.elapsed);
        this.clock.string = `${this.size}×${this.size}  ${Math.floor(seconds / 60)
            .toString()
            .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    }

    private fit(): void {
        const t = this.node.parent?.getComponent(UITransform);
        if (t && t.width > 0 && t.height > 0) {
            const scale = Math.min(t.width / 720, t.height / 1280);
            this.root.setScale(scale, scale, 1);
        }
    }

    private box(parent: Node, name: string, x: number, y: number, w: number, h: number): Node {
        const n = new Node(name);
        n.layer = parent.layer;
        parent.addChild(n);
        n.setPosition(x, y);
        n.addComponent(UITransform).setContentSize(w, h);
        return n;
    }

    private paint(n: Node, w: number, h: number, color: string): void {
        const g = n.addComponent(Graphics);
        g.fillColor = new Color().fromHEX(color);
        g.roundRect(-w / 2, -h / 2, w, h, 16);
        g.fill();
    }

    private text(
        parent: Node,
        text: string,
        x: number,
        y: number,
        w: number,
        h: number,
        font: number,
        color = INK,
    ): Label {
        const n = this.box(parent, 'Text', x, y, w, h);
        const l = n.addComponent(Label);
        l.string = text;
        l.fontSize = font;
        l.lineHeight = font + 4;
        l.horizontalAlign = Label.HorizontalAlign.CENTER;
        l.verticalAlign = Label.VerticalAlign.CENTER;
        l.color = new Color().fromHEX(color);
        return l;
    }

    private button(title: string, x: number, y: number, width: number, action: () => void, color = '#e8cf9a'): Label {
        const n = this.box(this.root, title, x, y, width, 48);
        this.paint(n, width, 48, color);
        const l = this.text(n, title, 0, 0, width, 48, 23);
        n.on(Node.EventType.TOUCH_END, (event: EventTouch) => {
            event.propagationStopped = true;
            if (this.touchId !== null) return;
            action();
        });
        return l;
    }

    private difficulty(): Difficulty {
        return this.size === 5 ? 'easy' : this.size === 10 ? 'normal' : 'hard';
    }

    private newGame(d: Difficulty): void {
        this.finishStroke();
        if (this.editing) {
            this.size = { easy: 5, normal: 10, hard: 15 }[d];
            this.solution = Array<number>(this.size * this.size).fill(0);
        } else {
            const puzzle = generatePuzzle(d, Date.now());
            this.size = puzzle.size;
            this.solution = puzzle.solution;
            this.draft = null;
        }
        this.restart();
    }

    private restart(): void {
        this.finishStroke();
        this.clearVictory();
        this.cells = Array<number>(this.size * this.size).fill(0);
        this.undo = [];
        this.redo = [];
        this.elapsed = 0;
        this.won = false;
        this.assisted = false;
        this.notify(
            this.editing
                ? '编辑：直接绘制答案，数字实时更新；切换尺寸会清空答案'
                : '填色正确即可通关，空白不必全部打叉；拖动支持一笔撤销',
        );
        this.refresh();
    }

    private indexAt(event: EventTouch): number {
        const p = event.getUILocation();
        const v = this.board.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
        const x = v.x + 255;
        const y = 255 - v.y;
        if (x < 0 || y < 0 || x >= 510 || y >= 510) return -1;
        return Math.floor(y / (510 / this.size)) * this.size + Math.floor(x / (510 / this.size));
    }

    private begin(event: EventTouch): void {
        if (this.touchId !== null || (!this.editing && this.won)) return;
        const index = this.indexAt(event);
        if (index < 0) return;
        this.touchId = event.getID();
        const data = this.editing ? this.solution : this.cells;
        this.before = data.slice();
        const target = this.editing ? 1 : this.cross ? -1 : 1;
        this.strokeValue = data[index] === target ? 0 : target;
        this.visited.clear();
        this.last = -1;
        this.drawTo(index);
        event.propagationStopped = true;
    }

    private move(event: EventTouch): void {
        if (event.getID() !== this.touchId) return;
        const index = this.indexAt(event);
        // 出界立即终止，重新进入棋盘必须抬手，不在两端之间连线。
        if (index < 0) this.finishStroke();
        else this.drawTo(index);
        event.propagationStopped = true;
    }

    private drawTo(index: number): void {
        const data = this.editing ? this.solution : this.cells;
        const r = Math.floor(index / this.size);
        const c = index % this.size;
        const previous = this.last < 0 ? index : this.last;
        const pr = Math.floor(previous / this.size);
        const pc = previous % this.size;
        const steps = Math.max(Math.abs(r - pr), Math.abs(c - pc), 1);
        for (let i = 0; i <= steps; i++) {
            const cell = Math.round(pr + ((r - pr) * i) / steps) * this.size + Math.round(pc + ((c - pc) * i) / steps);
            if (!this.visited.has(cell)) {
                data[cell] = this.strokeValue;
                this.visited.add(cell);
            }
        }
        this.last = index;
        this.refresh();
    }

    private end(event: EventTouch): void {
        if (event.getID() === this.touchId) this.finishStroke();
    }

    private finishStroke(): void {
        if (this.before) {
            const data = this.editing ? this.solution : this.cells;
            if (data.some((v, i) => v !== this.before![i])) {
                this.undo.push(this.before);
                this.redo = [];
            }
        }
        this.before = null;
        this.touchId = null;
        this.last = -1;
        if (this.solution.length === this.size * this.size) this.refresh();
        this.checkWin();
    }

    private history(forward: boolean): void {
        const from = forward ? this.redo : this.undo;
        const to = forward ? this.undo : this.redo;
        const state = from.pop();
        if (!state) {
            this.notify(forward ? '没有可重做的操作' : '没有可撤销的操作');
            return;
        }
        to.push((this.editing ? this.solution : this.cells).slice());
        if (this.editing) this.solution = state;
        else this.cells = state;
        this.clearVictory();
        this.refresh();
        this.checkWin();
    }

    private checkWin(): void {
        if (!this.status || this.editing || !this.cells.length) return;
        const wasWon = this.won;
        this.won = this.cells.every((v, i) => (v === 1) === (this.solution[i] === 1));
        if (!this.won) this.clearVictory();
        if (this.won && !wasWon) this.showVictory();
        if (this.won) this.notify(`★ 通关！${this.assisted ? '使用过答案辅助' : '独立完成'} · 可撤销或开始新关`);
    }

    private clearVictory(): void {
        if (!this.victory) return;
        Tween.stopAllByTarget(this.victory);
        const opacity = this.victory.getComponent(UIOpacity);
        if (opacity) Tween.stopAllByTarget(opacity);
        this.victory.destroy();
        this.victory = null;
    }

    private showVictory(): void {
        this.clearVictory();
        const node = this.text(this.root, '恭喜通关', 55, -30, 510, 90, 48, '#fff4c9').node;
        node.name = 'VictoryToast';
        this.victory = node;
        const opacity = node.addComponent(UIOpacity);
        tween(node)
            .to(1.6, { position: new Vec3(55, 90, 0) })
            .start();
        tween(opacity)
            .delay(0.6)
            .to(1, { opacity: 0 })
            .call(() => {
                if (this.victory === node) this.clearVictory();
            })
            .start();
    }

    private hint(): void {
        if (this.editing) {
            this.notify('编辑模式请使用验证；提示仅用于试玩 / 解题');
            return;
        }
        const index = this.cells.findIndex((v, i) => (v === 1) !== (this.solution[i] === 1));
        if (index < 0) return;
        this.undo.push(this.cells.slice());
        this.redo = [];
        this.cells[index] = this.solution[index] === 1 ? 1 : -1;
        this.assisted = true;
        this.notify('答案辅助：已按答案修正一格（非逻辑推导提示）');
        this.refresh();
        this.checkWin();
    }

    private refresh(): void {
        // Startup and size changes reach finishStroke before restart allocates manual cells.
        if (!this.graphics || this.cells.length !== this.size * this.size) return;
        const g = this.graphics;
        const step = 510 / this.size;
        g.clear();
        g.fillColor = new Color().fromHEX('#fff0b6');
        g.rect(-255, -255, 510, 510);
        g.fill();
        const data = this.editing ? this.solution : autoCrossCompletedLines(this.cells, this.solution, this.size);
        data.forEach((v, i) => {
            const x = -255 + (i % this.size) * step;
            const y = 255 - Math.floor(i / this.size) * step;
            if (v === 1) {
                g.fillColor = new Color().fromHEX(this.editing ? '#7e65ae' : '#4f9474');
                g.roundRect(x + 3, y - step + 3, step - 6, step - 6, 3);
                g.fill();
            } else if (v === -1) {
                g.fillColor = new Color().fromHEX('#594b43');
                const half = step * 0.275;
                const offset = Math.min(7, Math.max(3, step * 0.09)) / (2 * Math.SQRT2);
                const cx = x + step / 2;
                const cy = y - step / 2;
                for (const slope of [-1, 1]) {
                    g.moveTo(cx - half - slope * offset, cy - slope * half + offset);
                    g.lineTo(cx + half - slope * offset, cy + slope * half + offset);
                    g.lineTo(cx + half + slope * offset, cy + slope * half - offset);
                    g.lineTo(cx - half + slope * offset, cy - slope * half - offset);
                    g.close();
                    g.fill();
                }
            }
        });
        for (let i = 0; i <= this.size; i++) {
            const width = i === 0 || i === this.size ? 5 : i % 5 === 0 ? 3 : 1.5;
            g.fillColor = new Color().fromHEX(i === 0 || i === this.size ? '#69b52e' : '#86a276');
            g.rect(-255 + i * step - width / 2, -255, width, 510);
            g.rect(-255, -255 + i * step - width / 2, 510, width);
            g.fill();
        }
        this.clues.children.slice().forEach((n) => n.destroy());
        const { rows, cols } = getClues(this.solution, this.size);
        const font = this.size === 15 ? 15 : this.size === 10 ? 19 : 24;
        rows.forEach((row, i) => {
            const done = getCompletedClues(this.cells.slice(i * this.size, (i + 1) * this.size), row);
            const values = row.length ? row : [0];
            const spacing = Math.min(font + 5, 108 / values.length);
            values.forEach((value, j) =>
                this.text(
                    this.clues,
                    String(value),
                    -206 - (values.length - j - 0.5) * spacing,
                    213 - (i + 0.5) * step,
                    spacing,
                    step,
                    font,
                    !this.editing &&
                        (row.length ? done[j] : !this.cells.slice(i * this.size, (i + 1) * this.size).includes(1))
                        ? '#b6bdd3'
                        : '#fff4cc',
                ),
            );
        });
        cols.forEach((col, i) => {
            const line = Array.from({ length: this.size }, (_, r) => this.cells[r * this.size + i]);
            const done = getCompletedClues(line, col);
            const values = col.length ? col : [0];
            const spacing = Math.min(font + 2, 104 / values.length);
            values.forEach((value, j) =>
                this.text(
                    this.clues,
                    String(value),
                    -200 + (i + 0.5) * step,
                    216 + (values.length - j - 0.5) * spacing,
                    step,
                    spacing + 4,
                    font,
                    !this.editing && (col.length ? done[j] : !line.includes(1)) ? '#b6bdd3' : '#fff4cc',
                ),
            );
        });
        this.modeLabel.string = this.editing ? '■ 编辑答案' : this.cross ? '■ 填涂' : '■ 填涂 ✓';
        this.editorLabel.string = this.editing ? '退出编辑' : '编辑答案';
    }

    private toggleEditor(): void {
        this.finishStroke();
        if (this.editing) {
            this.save();
            this.editing = false;
            this.draft = null;
        } else {
            if (this.draft) {
                this.size = this.draft.size;
                this.solution = this.draft.solution.slice();
            }
            this.editing = true;
            this.draft = null;
        }
        this.restart();
    }

    private tryDraft(): void {
        if (this.editing) {
            this.save();
            this.draft = { size: this.size, solution: this.solution.slice() };
            this.editing = false;
            this.restart();
            this.notify('自制关卡试玩 · 点击“试玩 / 返回”恢复答案编辑');
        } else if (this.draft) {
            this.size = this.draft.size;
            this.solution = this.draft.solution.slice();
            this.editing = true;
            this.draft = null;
            this.restart();
        } else this.notify('先点击“编辑答案”绘制自制关卡');
    }

    private validate(): void {
        const result = analyzePuzzle(this.solution, this.size);
        const level: Record<string, string> = { easy: '简单', normal: '中等', hard: '需分支搜索', ambiguous: '多解' };
        this.notify(
            `${result.unique ? '唯一解' : '非唯一解'} · ${result.logicSolved ? '纯逻辑可解' : '非纯逻辑解出'} · ${level[result.difficulty]}\n传播 ${result.rounds} 轮 / 搜索 ${result.branches} 分支`,
        );
    }

    private exportJSON(): void {
        this.input.string = JSON.stringify({ version: 1, size: this.size, solution: this.solution });
        this.save();
        this.notify('答案 JSON 已写入原生文本框，可选择并复制');
    }

    private parse(text: string): { size: number; solution: number[] } {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== 'object') throw new Error('需要 JSON 对象');
        const data = value as { size?: unknown; solution?: unknown };
        if (
            typeof data.size !== 'number' ||
            ![5, 10, 15].includes(data.size) ||
            !Array.isArray(data.solution) ||
            data.solution.length !== data.size ** 2 ||
            !data.solution.every((v: unknown) => v === 0 || v === 1)
        )
            throw new Error('尺寸只允许5/10/15，solution必须为对应长度的0/1数组');
        return { size: data.size, solution: data.solution as number[] };
    }

    private importJSON(): void {
        try {
            const data = this.parse(this.input.string);
            this.size = data.size;
            this.solution = data.solution;
            this.editing = true;
            this.draft = null;
            this.restart();
            this.save();
            this.notify('已导入答案，处于编辑模式；请验证后试玩');
        } catch (error) {
            this.notify(`导入失败：${error instanceof Error ? error.message : '无效JSON'}`);
        }
    }

    private save(): void {
        try {
            sys.localStorage.setItem('nonogram.draft.v1', JSON.stringify({ size: this.size, solution: this.solution }));
        } catch {
            /* 存储被禁用时不影响游戏与文本导出。 */
        }
    }

    private restore(): void {
        try {
            const text = sys.localStorage.getItem('nonogram.draft.v1');
            if (text) {
                this.parse(text);
                this.input.string = text;
                this.notify('发现本地答案草稿，点击导入可恢复；当前仍为新关');
            }
        } catch {
            /* 损坏或禁用的本地存储不阻断启动。 */
        }
    }

    private notify(message: string): void {
        this.message = message;
        if (this.status) this.status.string = this.message;
    }
}
