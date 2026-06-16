# Over-engineering Review

The examples above are about how enigma *writes* code. This one is about how it
*reviews* existing code: the `anti-overengineering-review` skill, invoked by
asking to "review this for over-engineering", "audit the codebase for bloat",
"what can we delete", or "list the deferred shortcuts". It only lists cuts - it
never applies them - and leaves correctness and security to a normal review pass.

## Without enigma

A general review comments on style and hedges:

> "This `EmailValidator` class looks reasonable. You might consider whether all
> the validation rules are necessary at this stage, and maybe add some tests.
> The `AbstractRepository` is a nice pattern for future flexibility."

Vague, non-actionable, and it praises the speculative abstraction instead of
flagging it.

## With enigma

**Review (a diff)** - one line per finding, tagged, with the replacement and a
net line count:

```
L12-38: stdlib: 27-line email validator class. "@" check in one line; real validation is the confirmation mail.
L4:     native: moment.js imported for one format call. Intl.DateTimeFormat, 0 deps.
repo.py:L88: yagni: AbstractRepository with one implementation. Inline it until a second one exists.
L52-71: delete: retry wrapper around an idempotent local call. Nothing replaces it.
L30-44: shrink: manual loop builds a dict. dict(zip(keys, values)), 1 line.
net: -71 lines possible.
```

**Audit (whole repo)** - same tags, ranked biggest cut first:

```
yagni:  EventBus with one publisher and one subscriber. Call the function directly. [src/events.py]
native: custom debounce util. AbortSignal.timeout / lodash already vendored.       [web/src/util/debounce.ts]
delete: feature flag `enableNewParser` that is true everywhere and never read off. [src/config.ts]
net: -340 lines, -2 deps possible.
```

**Debt (marker ledger)** - harvest the `enigma:` shortcuts so a deferral cannot
quietly become permanent:

```
src/cache.py:14 - in-process lru_cache. ceiling: single worker. upgrade: move to Redis when we run >1 worker.
src/lock.py:8  - global lock around writes. no-trigger
2 markers, 1 with no trigger.
```

The tags (`delete` / `stdlib` / `native` / `yagni` / `shrink`) are the same
vocabulary in every mode, the score is the only summary that matters, and
`no-trigger` flags the shortcuts that named no upgrade path - the ones that rot.
