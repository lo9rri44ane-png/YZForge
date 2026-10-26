import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
    analyzePuzzle,
    autoCrossCompletedLines,
    cluesOf,
    generatePuzzle,
    getClues,
    getCompletedClues,
    solvePuzzle,
    type Difficulty,
} from '../assets/game/app/nonogram/NonogramLogic';

test('nonogram clues preserve runs, empty lines and row-major columns', () => {
    assert.deepEqual(cluesOf([]), []);
    assert.deepEqual(cluesOf([0, 0]), []);
    assert.deepEqual(cluesOf([1, 1, 0, 1, 0, 1, 1]), [2, 1, 2]);
    assert.deepEqual(getClues([1, 0, 1, 1], 2), { rows: [[1], [2]], cols: [[2], [1]] });
    assert.throws(() => cluesOf([2]), RangeError);
    assert.throws(() => getClues([1], 2), RangeError);
    assert.throws(() => getClues([], 0), RangeError);
    assert.throws(() => solvePuzzle([[0]], [[]]), RangeError);
});

test('nonogram completed rows and columns cross only untouched cells without mutating inputs', () => {
    const solution = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const cells = [1, 0, -1, 0, 0, 0, 0, 0, 0];
    const original = cells.slice();
    assert.deepEqual(autoCrossCompletedLines(cells, solution, 3), [1, -1, -1, -1, 0, 0, -1, 0, 0]);
    assert.deepEqual(cells, original);
    assert.deepEqual(solution, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.notEqual(autoCrossCompletedLines(cells, solution, 3), cells);
    assert.deepEqual(autoCrossCompletedLines([0, 0, 0, 0], [0, 0, 0, 0], 2), [-1, -1, -1, -1]);
});

test('nonogram completion compares ordered runs, not totals or answer positions', () => {
    const solution = [1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const cells = [1, 0, 1, 0, ...Array<number>(12).fill(0)];
    assert.deepEqual(autoCrossCompletedLines(cells, solution, 4), cells);
    const shifted = [0, 1, 1, 0, ...Array<number>(12).fill(0)];
    assert.deepEqual(autoCrossCompletedLines(shifted, solution, 4).slice(0, 4), [-1, 1, 1, -1]);
    const ordered = [1, 0, 1, 1, 0, ...Array<number>(20).fill(1)];
    const reversed = [1, 1, 0, 1, 0, ...Array<number>(20).fill(0)];
    assert.deepEqual(autoCrossCompletedLines(reversed, ordered, 5), reversed);
});

test('nonogram strokes and hints share auto-cross undo, while editing stays untouched', () => {
    const source = readFileSync(new URL('../assets/game/app/nonogram/NonogramDemo.ts', import.meta.url), 'utf8');
    const method = (name: string): ((this: typeof state) => void) => {
        const body = source.match(new RegExp(`    private ${name}\\(\\): void \\{([\\s\\S]*?)\\n    \\}`))![1];
        const js = ts.transpileModule(`function action() {${body}\n}`, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
        return new Function('autoCrossCompletedLines', `${js}; return action;`)(autoCrossCompletedLines);
    };
    const state = {
        size: 2,
        solution: [1, 0, 0, 1],
        cells: [1, 0, 0, 0],
        before: [0, 0, 0, 0] as number[] | null,
        undo: [] as number[][],
        redo: [] as number[][],
        editing: false,
        refresh() {},
        checkWin() {},
        notify() {},
    };
    method('finishStroke').call(state);
    assert.deepEqual(state.cells, [1, 0, 0, 0]);
    assert.deepEqual(state.undo, [[0, 0, 0, 0]]);
    method('hint').call(state);
    assert.deepEqual(state.cells, [1, 0, 0, 1]);
    assert.deepEqual(state.undo[1], [1, 0, 0, 0]);
    state.editing = true;
    state.before = [0, 0, 0, 0];
    state.cells = [0, 0, 0, 0];
    method('finishStroke').call(state);
    method('hint').call(state);
    assert.deepEqual(state.solution, [1, 0, 0, 1]);
    assert.deepEqual(state.cells, [0, 0, 0, 0]);
    assert.equal(state.undo.length, 3);
});

for (const [name, line, clues, expected] of [
    ['unique second run', [0, 1, 1, 0], [1, 2], [false, true]],
    ['erased run restores clue', [0, 0, 0, 0], [1, 2], [false, false]],
    ['ambiguous repeated ones', [1, 0, 0], [1, 1], [false, false]],
    ['ordered repeated runs complete', [1, 0, 1], [1, 1], [true, true]],
    ['full sequence complete', [1, -1, 1, 1], [1, 2], [true, true]],
    ['reverse order inconsistent', [1, 1, 0, 1], [1, 2], [false, false]],
    ['oversized run inconsistent', [1, 1, 1], [1, 2], [false, false]],
    ['extra runs inconsistent', [1, 0, 1, 0, 1], [1, 1], [false, false]],
    ['common unique clue amid ambiguity', [1, 0, 1, 1], [1, 1, 2], [false, false, true]],
    ['order disambiguates repeated clue', [1, 1, 0, 1], [1, 2, 1], [false, true, true]],
    ['empty clues', [0, -1], [], []],
] as [string, number[], number[], boolean[]][]) {
    test(`nonogram clue completion: ${name}`, () => {
        const before = line.slice();
        assert.deepEqual(getCompletedClues(line, clues), expected);
        assert.deepEqual(line, before);
    });
}

test('nonogram erasing fill removes derived crosses but preserves manual crosses', () => {
    const solution = [1, 0, 0, 1];
    const manual = [1, -1, 0, 0];
    assert.deepEqual(autoCrossCompletedLines(manual, solution, 2), [1, -1, -1, 0]);
    manual[0] = 0;
    assert.deepEqual(autoCrossCompletedLines(manual, solution, 2), [0, -1, 0, 0]);
    manual[0] = 1;
    assert.deepEqual(autoCrossCompletedLines(manual, solution, 2), [1, -1, -1, 0]);
    // Filling a displayed automatic cross is a normal manual fill, never an erase.
    assert.equal(manual[2], 0);
    manual[2] = 1;
    assert.equal(autoCrossCompletedLines(manual, solution, 2)[2], 1);
});

test('nonogram cross persists while another completed line still owns it', () => {
    const solution = [1, 0, 0, 0];
    assert.deepEqual(autoCrossCompletedLines([0, 0, 0, 0], solution, 2), [0, -1, -1, -1]);
});

test('nonogram invalid completion inputs are rejected', () => {
    assert.throws(() => getCompletedClues([2], [1]), RangeError);
    assert.throws(() => getCompletedClues([0], [0]), RangeError);
});

test('nonogram victory notification is edge-triggered and cleared on losing state', () => {
    const source = readFileSync(new URL('../assets/game/app/nonogram/NonogramDemo.ts', import.meta.url), 'utf8');
    const body = source.match(/ {4}private checkWin\(\): void \{([\s\S]*?)\n {4}\}/)![1];
    const js = ts.transpileModule(`function action() {${body}\n}`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const action = new Function(`${js}; return action;`)();
    let shown = 0;
    let cleared = 0;
    const state = {
        status: {},
        editing: false,
        cells: [1, 0],
        solution: [1, 0],
        won: false,
        showVictory() {
            shown++;
        },
        clearVictory() {
            cleared++;
        },
        notify() {},
    };
    action.call(state);
    action.call(state);
    assert.equal(shown, 1);
    state.cells[0] = 0;
    action.call(state);
    assert.equal(cleared, 1);
    state.cells[0] = 1;
    action.call(state);
    assert.equal(shown, 2);
    state.editing = true;
    state.won = false;
    action.call(state);
    assert.equal(shown, 2);
});

test('nonogram propagation, contradictions and two-solution cutoff', () => {
    const solved = solvePuzzle([[2], []], [[1], [1]]);
    assert.deepEqual(solved.solutions, [[1, 1, 0, 0]]);
    assert.equal(solved.logicSolved, true);
    assert.equal(solved.branches, 0);
    assert.ok(solved.rounds > 0);
    assert.deepEqual(solvePuzzle([[2]], [[]]).solutions, []);
    assert.deepEqual(solvePuzzle([[1]], [[]]).solutions, []);
    assert.deepEqual(solvePuzzle([[]], [[]]).solutions, [[0]]);
    const multiple = solvePuzzle([[1], [1], [1]], [[1], [1], [1]]);
    assert.equal(multiple.solutions.length, 2);
    assert.notDeepEqual(multiple.solutions[0], multiple.solutions[1]);
    assert.equal(multiple.logicSolved, false);
    assert.ok(multiple.branches > 0);
    assert.equal(analyzePuzzle([1, 0, 0, 1], 2).unique, false);
});

test('nonogram solver agrees with exhaustive enumeration of every 3 by 3 clue set', () => {
    const groups = new Map<string, number[][]>();
    for (let bits = 0; bits < 512; bits++) {
        const solution = Array.from({ length: 9 }, (_, i) => (bits >>> i) & 1);
        const key = JSON.stringify(getClues(solution, 3));
        const group = groups.get(key) ?? [];
        group.push(solution);
        groups.set(key, group);
    }
    for (const [key, expected] of groups) {
        const clues = JSON.parse(key) as { rows: number[][]; cols: number[][] };
        const actual = solvePuzzle(clues.rows, clues.cols);
        assert.equal(actual.solutions.length, Math.min(2, expected.length));
        for (const solution of actual.solutions) assert.ok(expected.some((s) => s.every((v, i) => v === solution[i])));
    }
});

for (const [difficulty, size] of [
    ['easy', 5],
    ['normal', 10],
    ['hard', 15],
] as const) {
    test(`nonogram ${difficulty} generation is deterministic and strictly unique`, () => {
        for (const seed of [0, 1, -17, 20261027]) {
            const puzzle = generatePuzzle(difficulty as Difficulty, seed);
            assert.deepEqual(generatePuzzle(difficulty, seed), puzzle);
            assert.equal(puzzle.size, size);
            assert.equal(puzzle.seed, seed);
            assert.equal(puzzle.difficulty, difficulty);
            assert.equal(puzzle.solution.length, size * size);
            assert.equal(puzzle.analysis.unique, true);
            assert.deepEqual(puzzle.analysis, analyzePuzzle(puzzle.solution, size));
            const { rows, cols } = getClues(puzzle.solution, size);
            assert.deepEqual(solvePuzzle(rows, cols).solutions, [puzzle.solution]);
        }
    });
}

test('nonogram measured difficulty is independent of board size', () => {
    for (const size of [5, 10, 15]) {
        assert.equal(analyzePuzzle(Array<number>(size * size).fill(1), size).difficulty, 'easy');
    }
    assert.throws(() => generatePuzzle('easy', Infinity), RangeError);
});
