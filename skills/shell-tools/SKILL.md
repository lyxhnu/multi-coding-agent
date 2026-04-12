---
name: shell-tools
description: Production-grade shell tools - jq, xargs, parallel, pipelines
---

# Shell Tools Skill

> Master jq, xargs, GNU parallel, and advanced pipelines

## Learning Objectives

After completing this skill, you will be able to:
- [ ] Process JSON with jq
- [ ] Use xargs for argument handling
- [ ] Parallelize tasks with GNU parallel
- [ ] Build efficient data pipelines
- [ ] Use utility commands effectively

## Prerequisites

- Strong Bash fundamentals
- Text processing basics
- Understanding of pipes

## Core Concepts

### 1. jq Essentials
```bash
# Basic queries
jq '.' file.json              # Pretty print
jq '.key' file.json           # Get key
jq '.array[0]' file.json      # First element
jq '.nested.key' file.json    # Nested

# Filtering
jq '.[] | select(.active)'    # Filter
jq '.[] | select(.count > 10)'

# Transform
jq '.[] | {id, name}'         # Select fields
jq 'map(.price * .qty)'       # Calculate
jq -r '.[] | @csv'            # To CSV

# From variables
jq -n --arg x "$VAR" '{value: $x}'
```

### 2. Xargs
```bash
# Basic usage
echo "a b c" | xargs echo

# Safe with spaces
find . -print0 | xargs -0 rm

# Limit arguments
cat list | xargs -n 1 process
cat list | xargs -n 10 process

# Parallel
cat list | xargs -P 4 -n 1 process

# Placeholder
cat urls | xargs -I {} curl {}
```

### 3. GNU Parallel
```bash
# Basic
parallel echo ::: a b c

# From file
parallel process :::: list.txt

# With options
parallel -j 4 process ::: *.txt
parallel --progress process ::: *.txt

# Complex
parallel -j 4 --delay 0.5 \
    'curl -s {} | jq .name' :::: urls.txt
```

### 4. Pipeline Utilities
```bash
# Sort and unique
sort file.txt
sort -n file.txt          # Numeric
sort -u file.txt          # Unique
sort file | uniq -c       # Count

# Cut and paste
cut -d',' -f1,3 file.csv
paste file1.txt file2.txt

# Transform
tr 'a-z' 'A-Z' < file
tr -d '\r' < dos.txt > unix.txt
```

## Common Patterns

### API Data Pipeline
```bash
curl -s 'https://api.example.com/users' |
    jq -r '.[] | select(.active) | [.id, .email] | @csv' |
    sort -t',' -k2 |
    head -20
```

### Parallel Processing
```bash
# Compress all logs in parallel
find . -name "*.log" |
    parallel -j 4 gzip

# Batch API calls with rate limit
cat ids.txt |
    parallel -j 5 --delay 0.2 \
        'curl -s "https://api.example.com/item/{}"'
```

### Data Transformation
```bash
# JSON to formatted output
cat data.json |
    jq -r '.items[] | "\(.id)\t\(.name)\t\(.price)"' |
    column -t
```

## Anti-Patterns

| Don't | Do | Why |
|-------|-----|-----|
| Parse JSON with grep | Use jq | Proper parsing |
| Sequential when parallel | Use parallel | Speed |
| `cat \| xargs` | `xargs < file` | Efficiency |

## Practice Exercises

1. **JSON Processor**: Transform API response
2. **Batch Processor**: Parallel file processing
3. **Log Analyzer**: Complex log pipeline
4. **Data Migrator**: Transform and load data

## Troubleshooting

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `jq: error` | Invalid JSON | Validate with `jq .` |
| `xargs: arg too long` | Too many args | Use `-n` |
| `parallel: not found` | Not installed | `apt install parallel` |

### Debug Techniques
```bash
# Validate JSON
jq '.' < input.json

# Debug pipeline
command1 | tee /dev/stderr | command2

# Test jq filter
echo '{"a":1}' | jq '.a'
```

## Performance Tips

```bash
# Faster sorting
LC_ALL=C sort file.txt

# Parallel for CPU-bound
parallel -j $(nproc) process ::: *.txt

# Stream large files
jq -c '.[]' large.json | while read -r line; do
    # process line
done
```

## Resources

- [jq Manual](https://stedolan.github.io/jq/manual/)
- [GNU Parallel Tutorial](https://www.gnu.org/software/parallel/parallel_tutorial.html)
- [jq Playground](https://jqplay.org/)

Overview

This skill delivers production-grade shell tooling patterns centered on jq, xargs, GNU parallel, and efficient pipelines. It teaches reliable JSON processing, safe argument handling, parallel task execution, and composing fast data transformations. The content focuses on practical commands, common patterns, anti-patterns, and troubleshooting tips for real-world workflows.

How this skill works

You learn concrete commands and idioms that inspect and transform data streams: jq for robust JSON parsing and transformation, xargs for controlled argument passing and batching, GNU parallel for concurrency and rate-limited jobs, and core Unix utilities (sort, cut, tr, column) for shaping text. Examples show how these tools chain via pipes and files, how to handle edge cases (spaces, large arg lists, invalid JSON), and how to benchmark and debug pipelines.

When to use it

Extract and transform API JSON responses for reporting or downstream processing

Batch or parallelize IO- or CPU-bound tasks like downloads, compression, or image processing

Safely construct command arguments from files or find output (handling spaces/newlines)

Convert JSON to CSV/TSV or formatted tables for human review or imports

Optimize large-file workflows with streaming, locale-tuned sort, and parallelism

Best practices

Always parse JSON with jq instead of grep/sed to avoid brittle errors

Use find -print0 and xargs -0 or null-delimited jq output for safe filenames

Prefer GNU parallel for complex concurrency, with --delay and -j to avoid API rate limits

Stream large JSON with jq -c and process line-by-line to reduce memory use

Set LC_ALL=C for faster sort on large datasets and use nproc to size parallel jobs

Example use cases

Fetch users from an API, filter active accounts with jq, sort by email and show the top 20

Compress all .log files in a directory in parallel with find | parallel -j 4 gzip

Batch API item retrieval from ids.txt using parallel --delay to respect rate limits

Convert nested JSON items to a tabular report with jq -r and column -t for readability

Process a huge JSON array by streaming jq -c '.[]' and handling each entry in a loop

FAQ

What if jq reports invalid JSON?

Validate the input with jq '.' to find syntax errors, or produce compact records with jq -c and inspect problematic lines.

How do I avoid xargs 'arg too long' errors?

Use xargs -n to limit args per command, -0 with null-delimited input, or switch to GNU parallel for more flexible batching.

Skill score

0

Health score

i

D

65
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

automation

devops

data

cli

scripting

Trigger phrases

analyze json

process data

build pipelines

parallelize tasks

transform outputs

optimize pipelines

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
