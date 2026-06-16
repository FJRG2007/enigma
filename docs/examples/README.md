# Examples: with vs without enigma

These are side-by-side examples of the same task solved by a baseline coding
agent ("Without enigma") and by an agent running enigma's minimal-code
discipline ("With enigma" - the `anti-overengineering-policy` skill, switched on
with `enigma config minimal-code full`).

The point is not that less code is always better. It is that the baseline
reaches for layers, dependencies, and hand-rolled algorithms by default, while
enigma walks the YAGNI ladder first: does this need to exist, does the standard
library do it, does a native platform feature cover it, can it be one line. The
trust boundaries that matter - input validation, data-loss handling, security,
accessibility - are never simplified away (see "When NOT to Be Lazy" in
`anti-overengineering-policy`).

Deliberate shortcuts are marked with an `enigma:` comment naming the ceiling and
the upgrade path, so a deferral stays visible and can be harvested later by the
`anti-overengineering-review` skill.

## Index

- [Sorting](sorting.md) - 24 lines -> 1 line
- [Email validation](email-validation.md) - 27 lines -> 1 line
- [Date picker](date-picker.md) - 1 dependency + 30 lines -> 0 dependencies + 1 line
- [Caching](caching.md) - 120 lines -> 0-3 lines
- [API endpoint](api-endpoint.md) - 5 files -> 9 lines
- [Over-engineering review](over-engineering-review.md) - what the `anti-overengineering-review` skill reports

## Configure

```bash
enigma config minimal-code lite     # build what's asked, name the lazier alternative
enigma config minimal-code full     # the YAGNI ladder enforced (the "With enigma" column)
enigma config minimal-code ultra    # YAGNI extremist, deletion before addition
enigma config minimal-code off      # baseline, no extra pressure (default)
```
