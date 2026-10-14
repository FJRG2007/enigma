---
description: Explain how a feature of a shipped app works, from the artifact's own evidence. Usage: /investigate <target path> <feature>
---

# /investigate

Follow REA's `investigate_feature` workflow for the target and feature in the arguments.

1. Route the target with the `reverse-engineer-anything` skill (an Electron/JavaScript tree or
   ASAR goes to `analyze_javascript_application`; a binary or bundle to `open_binary`).
2. Find the feature's seeds: strings, symbols, routes, IPC channels or exports that name it.
3. Trace from each seed to the code that implements it; read the relevant functions.
4. Answer how the feature works, with the evidence for each step, the inferences labelled, and
   what stays unknown.
