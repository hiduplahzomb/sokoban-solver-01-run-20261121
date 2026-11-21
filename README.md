[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/hiduplahzomb/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/hiduplahzomb/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban solver

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver"
bounty. One run answers all 5 instances of a set in well under a second.

## How it works

A level is a hallway with independent rooms off it: each room holds 3-4
boxes and its own goals, a box pushed into the hallway can never come back,
and the level's push-optimal count is the sum of its rooms' optima. So the
solver:

1. **Decomposes** the level into rooms by cutting the hallway row.
2. **Solves each room push-optimally** with an A* search over pushes:
   - macro-pushes (the player walks freely between pushes),
   - a minimum-assignment heuristic from per-goal push distances,
   - dead-square pruning (reverse push search from the goals),
   - 2x2 deadlock pruning,
   - a transposition table keyed by boxes plus the player's reachable region.
3. **Stitches** the rooms together with walks along the hallway.

Push-optimal per room means push-optimal overall, so a solved level scores
the full 1,000 points. On the practice set it scores **1,000,000** (all five
instances in exactly P* pushes), against the house baseline's 200,000. On 30
fresh sets drawn by the kit's own generator it scores 1,000,000 on every one,
in at most ~0.4 s per set.

Search budgets are counted in expansions, never wall time, so two runs on
the same set write byte-identical answers.

## Run it

```sh
node main.ts
```

Reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`), one line of `u`,
`d`, `l`, `r` moves per instance. Node 22, no dependencies, no network.

<sub>Entered on [make.fun](https://make.fun/?ref=2wgaefze&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
