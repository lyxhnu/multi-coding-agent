---
name: assisting-reverse-engineering
description: Provides reverse engineering analysis support including function identification, data structure analysis, and behavior understanding. Use when analyzing unknown binaries, understanding program structu
---

# Reverse Engineering Assistance

## Analysis Workflow

1. **Initial survey**: Get function list, extract strings, identify imports and exports, map binary structure
2. **Key function analysis**: Decompile main/entry functions, analyze control flow, identify critical operations, classify functions by purpose
3. **Data flow mapping**: Trace data through functions, identify data structures, map global state, analyze stack layouts
4. **Behavior understanding**: Identify protocol handlers, understand input/output patterns, map to known functionality, reconstruct high-level logic

## Key Capabilities

- Function identification: entry points and main functions, common library functions, custom application logic, function classification
- Data structure analysis: strings and constants, data structures (structs, arrays), global variables, stack layouts
- Pattern recognition: common algorithms (sorting, hashing), protocol implementations, obfuscation techniques, anti-debugging code
- Code reconstruction: high-level logic reconstruction, control flow patterns, error handling, mapping to source concepts

## Output Format

Report with: binary_summary (type, architecture, language, compiler), key_functions (entry_points, protocol_handlers, utility_functions), data_structures, strings_of_interest, behavior_analysis (protocols, ports, functionality), recommendations.

## Quality Criteria

- **Accuracy**: Correct identification of functionality
- **Completeness**: Cover all key aspects
- **Clarity**: Clear explanations of behavior
- **Actionability**: Highlight areas needing review

## See Also

- `patterns.md` - Detailed analysis patterns and techniques
- `examples.md` - Example analysis cases and output formats
- `references.md` - Tools and best practices

Overview

This skill provides targeted reverse engineering analysis to help you identify functions, reconstruct data structures, and understand binary behavior. It produces a structured report that summarizes architecture, key functions, strings of interest, data structures, and behavioral findings. Use it to accelerate triage of unknown binaries and to prepare focused manual analysis steps.

How this skill works

The skill begins with an initial survey to enumerate functions, strings, imports/exports, and binary layout. It then performs focused analysis on key functions, reconstructs data flows and structures, and recognizes protocol or algorithmic patterns. Results are compiled into an actionable report with recommendations and prioritized items for deeper review.

When to use it

Triage an unfamiliar binary to determine potential risks and functionality

Map program structure before manual decompilation or debugging

Identify protocol handlers, network activity, or I/O surfaces

Extract likely data structures for vulnerability or forensic analysis

Analyze obfuscated code or anti-debugging techniques

Best practices

Start with a full binary survey (functions, imports, strings) before deep dives

Prioritize functions by entry points, exported symbols, and suspicious API calls

Correlate static findings with dynamic traces when possible to validate behavior

Document assumptions and confidence levels for each finding

Focus recommendations on actionable next steps: breakpoints, inputs, or sanitizers

Example use cases

Produce a concise report identifying network protocol handlers and likely ports for a suspicious sample

Reconstruct custom data structures to guide exploit development or patch analysis

Identify library vs. custom functions to speed decompilation and reduce noise

Highlight anti-analysis techniques and recommend settings to bypass them

Map control flow and error handling to support secure code reviews

FAQ

What does the report include?

A binary summary (type, arch, compiler), key_functions, data_structures, strings_of_interest, behavior_analysis, and prioritized recommendations.

How accurate are function classifications?

Classifications use pattern recognition and heuristics; combine with dynamic validation for high-confidence results.

Skill score

0

Health score

i

F

52
/100

Stats

278
 stars

First Seen

2 months ago

Repository

benchflow-ai
/
skillsbench

Tags

pddl

Topics

security

debugging

data

analytics

scripting

code-review

Trigger phrases

analyze binaries

identify functions

map data flows

inspect strings

reconstruct logic

classify functions

map protocols

review global state

#

#

#

#

Privacy

/

Terms

Made
 by
 
Ian Nuttall
