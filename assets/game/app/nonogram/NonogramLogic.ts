export type Difficulty = 'easy' | 'normal' | 'hard';

export function cluesOf(line: number[]): number[] {
    const clues: number[] = [];
    let run = 0;
    for (const cell of [...line, 0]) {
        if (cell !== 0 && cell !== 1) throw new RangeError('Cells must be 0 or 1');
        if (cell === 1) run++;
        else if (run) {
            clues.push(run);
            run = 0;
        }
    }
    return clues;
}

export function getClues(solution: number[], size: number): { rows: number[][]; cols: number[][] } {
    if (!Number.isInteger(size) || size < 1 || solution.length !== size * size) {
        throw new RangeError('Expected a positive square grid');
    }
    return {
        rows: Array.from({ length: size }, (_, r) => cluesOf(solution.slice(r * size, (r + 1) * size))),
        cols: Array.from({ length: size }, (_, c) =>
            cluesOf(Array.from({ length: size }, (_, r) => solution[r * size + c])),
        ),
    };
}

/** Only clues present in every monotone matching of the current runs are confirmed.
 * Unknown and crossed cells both separate runs; no answer positions are consulted.
 */
export function getCompletedClues(line: number[], clues: number[]): boolean[] {
    if (line.some((v) => v !== -1 && v !== 0 && v !== 1)) throw new RangeError('Invalid cell');
    if (clues.some((v) => !Number.isInteger(v) || v <= 0)) throw new RangeError('Invalid clue');
    const runs = cluesOf(line.map((v) => (v === 1 ? 1 : 0)));
    const common = clues.map(() => true);
    let matches = 0;
    const visit = (run: number, start: number, used: Set<number>): void => {
        if (run === runs.length) {
            matches++;
            common.forEach((_, i) => (common[i] = common[i] && used.has(i)));
            return;
        }
        for (let i = start; i <= clues.length - (runs.length - run); i++) {
            if (clues[i] !== runs[run]) continue;
            used.add(i);
            visit(run + 1, i + 1, used);
            used.delete(i);
        }
    };
    visit(0, 0, new Set());
    return matches ? common : clues.map(() => false);
}

/** Derived display only: never store this result in the manual cells/history. */
export function autoCrossCompletedLines(cells: number[], solution: number[], size: number): number[] {
    const { rows, cols } = getClues(solution, size);
    if (cells.length !== size * size || cells.some((v) => v !== -1 && v !== 0 && v !== 1)) {
        throw new RangeError('Expected a square grid of -1, 0 or 1');
    }
    const result = cells.slice();
    const complete = (indices: number[], expected: number[]): void => {
        const actual = cluesOf(indices.map((i) => (cells[i] === 1 ? 1 : 0)));
        if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) return;
        for (const i of indices) if (result[i] === 0) result[i] = -1;
    };
    for (let i = 0; i < size; i++) {
        complete(
            Array.from({ length: size }, (_, c) => i * size + c),
            rows[i],
        );
        complete(
            Array.from({ length: size }, (_, r) => r * size + i),
            cols[i],
        );
    }
    return result;
}

function patterns(clues: number[], size: number): number[][] {
    if (clues.some((n) => !Number.isInteger(n) || n <= 0)) throw new RangeError('Clues must be positive integers');
    const result: number[][] = [];
    const line = Array<number>(size).fill(0);
    const place = (index: number, start: number): void => {
        if (index === clues.length) {
            result.push(line.slice());
            return;
        }
        const remaining = clues.slice(index).reduce((a, b) => a + b, 0) + clues.length - index - 1;
        for (let pos = start; pos <= size - remaining; pos++) {
            line.fill(1, pos, pos + clues[index]);
            place(index + 1, pos + clues[index] + 1);
            line.fill(0, pos, pos + clues[index]);
        }
    };
    place(0, 0);
    return result;
}

/** rounds counts propagation sweeps across all visited states; branches counts attempted decisions.
 * logicSolved means the root was completed by propagation alone (not merely a unique search result).
 * Empty lines use []; impossible clues return zero solutions. Rectangular puzzles are supported.
 */
export function solvePuzzle(
    rows: number[][],
    cols: number[][],
): {
    solutions: number[][];
    rounds: number;
    branches: number;
    logicSolved: boolean;
} {
    const height = rows.length;
    const width = cols.length;
    if (!height || !width) throw new RangeError('Puzzle dimensions must be positive');
    const initial = [...rows.map((c) => patterns(c, width)), ...cols.map((c) => patterns(c, height))];
    const solutions: number[][] = [];
    let rounds = 0;
    let branches = 0;
    let logicSolved = false;
    const cellIndex = (line: number, offset: number): number =>
        line < height ? line * width + offset : offset * width + line - height;
    const search = (grid: number[], candidates: number[][][], root: boolean): void => {
        if (solutions.length >= 2) return;
        let changed = true;
        while (changed) {
            rounds++;
            changed = false;
            for (let l = 0; l < candidates.length; l++) {
                const filtered = candidates[l].filter((p) =>
                    p.every((value, i) => grid[cellIndex(l, i)] === -1 || grid[cellIndex(l, i)] === value),
                );
                if (!filtered.length) return;
                candidates[l] = filtered;
                for (let i = 0; i < filtered[0].length; i++) {
                    const index = cellIndex(l, i);
                    const value = filtered[0][i];
                    if (grid[index] === -1 && filtered.every((p) => p[i] === value)) {
                        grid[index] = value;
                        changed = true;
                    }
                }
            }
        }
        if (!grid.includes(-1)) {
            solutions.push(grid.slice());
            if (root) logicSolved = true;
            return;
        }
        let choice = -1;
        for (let l = 0; l < candidates.length; l++) {
            if (candidates[l].length > 1 && (choice < 0 || candidates[l].length < candidates[choice].length))
                choice = l;
        }
        for (const pattern of candidates[choice]) {
            if (solutions.length >= 2) break;
            branches++;
            const next = grid.slice();
            pattern.forEach((value, i) => (next[cellIndex(choice, i)] = value));
            const nextCandidates = candidates.slice();
            nextCandidates[choice] = [pattern];
            search(next, nextCandidates, false);
        }
    };
    search(Array<number>(height * width).fill(-1), initial, true);
    return { solutions, rounds, branches, logicSolved };
}

export function analyzePuzzle(
    solution: number[],
    size: number,
): {
    unique: boolean;
    logicSolved: boolean;
    rounds: number;
    branches: number;
    difficulty: string;
} {
    const { rows, cols } = getClues(solution, size);
    const { solutions, rounds, branches, logicSolved } = solvePuzzle(rows, cols);
    const unique = solutions.length === 1;
    const difficulty = !unique ? 'ambiguous' : branches > 0 ? 'hard' : rounds > 3 ? 'normal' : 'easy';
    return { unique, logicSolved, rounds, branches, difficulty };
}

/** Requested difficulty selects size/density, not a guarantee of the measured logic difficulty.
 * At most 24 random boards are checked. The fallback is a seeded nested-row board:
 * every nonempty row starts at the same edge, so column totals force its unique solution.
 */
export function generatePuzzle(
    difficulty: Difficulty,
    seed: number,
): {
    size: number;
    solution: number[];
    seed: number;
    difficulty: Difficulty;
    analysis: ReturnType<typeof analyzePuzzle>;
} {
    if (!['easy', 'normal', 'hard'].includes(difficulty)) throw new RangeError('Unknown difficulty');
    if (!Number.isFinite(seed)) throw new RangeError('Seed must be finite');
    const size = { easy: 5, normal: 10, hard: 15 }[difficulty];
    let state = seed >>> 0;
    const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), state | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    let best: { solution: number[]; analysis: ReturnType<typeof analyzePuzzle> } | undefined;
    for (let attempt = 0; attempt < 24; attempt++) {
        const density = { easy: 0.7, normal: 0.6, hard: 0.55 }[difficulty];
        const solution = Array.from({ length: size * size }, () => (random() < density ? 1 : 0));
        const analysis = analyzePuzzle(solution, size);
        if (analysis.unique) {
            best ??= { solution, analysis };
            if (analysis.difficulty === difficulty) return { size, solution, seed, difficulty, analysis };
        }
    }
    if (best) return { size, ...best, seed, difficulty };
    const lengths = Array.from({ length: size }, (_, i) => i + 1);
    for (let i = size - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [lengths[i], lengths[j]] = [lengths[j], lengths[i]];
    }
    const solution = lengths.flatMap((length) => Array.from({ length: size }, (_, c) => (c < length ? 1 : 0)));
    const analysis = analyzePuzzle(solution, size);
    if (!analysis.unique) throw new Error('Nonogram fallback invariant failed');
    return { size, solution, seed, difficulty, analysis };
}
