# Review and Benchmark Workflow

`cria` now has three separate layers:

- raw evidence:
  - `knowledge_documents`
  - `learning_feedback`
- review queue:
  - `review_queue`
- eval-only benchmark:
  - `benchmark_cases`
  - `benchmark_runs`
  - `benchmark_run_results`

## Why it is split this way

- raw evidence captures what happened
- review queue lets a human decide what is useful
- benchmark measures quality over time

Benchmark cases are **not** used directly for live replies.

## Typical Workflow

1. Let chat and scan collect real outcomes.
2. Review pending queue items:

```bash
bun run review -- queue:list
bun run review -- queue:summary
```

3. Mark useful items:

```bash
bun run review -- queue:mark <queue_id> reviewed_good
bun run review -- queue:mark <queue_id> reviewed_corrected "better category than original"
```

4. Promote representative cases:

```bash
bun run review -- queue:promote <queue_id> support_timing answer
```

5. Inspect active benchmark cases:

```bash
bun run review -- benchmark:list active
```

6. Run the benchmark suite:

```bash
bun run benchmark:run
```

7. Inspect trend summary:

```bash
bun run benchmark:summary
```

## Manual Additions

You can add queue or benchmark rows directly from JSON files.

Queue:

```bash
bun run review -- queue:add /absolute/path/to/review_case.json
```

Benchmark:

```bash
bun run review -- benchmark:add /absolute/path/to/benchmark_case.json
```

## Lifecycle

- reviewed queue items can be promoted
- benchmark cases can be updated
- outdated benchmark cases can be retired
- retired or stale cases stay in history but do not count as active benchmark coverage
