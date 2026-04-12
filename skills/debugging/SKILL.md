---
name: debugging
description: Apply systematic debugging methodology. Use when investigating bugs, unexpected behavior, or when user reports issues. Auto-apply when conversation includes "bug", "broken", "not working", "wrong", "g
---

# Debugging Skill

## Core Principle

**Automate first, ask questions never.** If you can write a test to verify behavior, do that instead of asking the user to manually check something.

## Debugging Decision Tree

```
Bug reported
    │
    ▼
Can I reproduce in a test?
    │
    ├─ YES → Write failing test first
    │         │
    │         ▼
    │    Does test fail?
    │         │
    │         ├─ YES → Debug the logic
    │         │
    │         └─ NO → Bug is in rendering/CSS layer
    │
    └─ NO → Need more info from user (specific steps, values)
```

## Systematic Isolation

| Question | Test Strategy |
|----------|---------------|
| Is the calculation correct? | Unit test with known inputs |
| Is the rendering correct? | Integration test, inspect CSS |
| Is it browser-specific? | Playwright test |
| Is it timing-related? | Time progression integration test |
| Is it state-related? | Expose `window.__debug`, inspect values |

## Common Bug Patterns

### 1. CSS Transitions + 60fps React

**Symptom**: Values correct in test, visual is wrong/flickering in browser.

**Cause**: CSS transitions on elements that React updates every frame.

**Detection**:
```bash
# Find transitions on frequently-updated elements
grep -r "transition:" src/ui/*.css
```

**Fix**: Remove CSS transitions from elements in the game loop render path.

### 2. State Not Updating

**Symptom**: UI shows stale data.

**Test**:
```javascript
it('state updates over time', () => {
  const { rerender } = render(<Component time={0} />);
  const value0 = getValue();

  rerender(<Component time={1000} />);
  const value1 = getValue();

  expect(value1).not.toEqual(value0);
});
```

### 3. Calculation Drift

**Symptom**: Values slowly diverge from expected over time.

**Test**:
```javascript
it('no drift over many iterations', () => {
  let state = initialState;
  for (let i = 0; i < 10000; i++) {
    state = update(state, 16); // 16ms per frame
  }
  expect(state.value).toBeCloseTo(expected, 2);
});
```

## Debug State Exposure

For browser inspection, expose state in dev mode:

```javascript
// In game loop
if (import.meta.env.DEV) {
  window.__debug = {
    state: world.setLullState,
    gameTime: world.gameTime,
    computed: { /* derived values */ }
  };
}
```

Then in browser console: `window.__debug.state`

## Anti-Patterns

| Don't Do This | Do This Instead |
|---------------|-----------------|
| Add `console.log`, ask user to check | Write Vitest test |
| Guess at the problem | Systematically isolate with tests |
| Fix symptoms | Find and fix root cause |
| Manual browser debugging | Playwright automation |
| Change code without understanding | Read and understand first |

## Integration with Testing Skill

When debugging, use these test patterns:

1. **Regression test** - Fails without fix, passes with fix
2. **Time progression test** - Simulates frames over time
3. **Edge case test** - Zero, negative, maximum values
4. **Snapshot test** - For complex state objects

## Debugging Checklist

- [ ] Can I write a failing test?
- [ ] Does the test isolate the bug?
- [ ] Have I checked CSS interactions?
- [ ] Have I verified state values?
- [ ] Is there a timing/animation issue?
- [ ] Did I find the root cause (not just symptoms)?

Overview

This skill applies a systematic debugging methodology focused on automation-first and minimal user questioning. It guides reproducing issues with failing tests, isolating root causes, and selecting targeted test strategies for calculation, rendering, timing, and state problems. The approach emphasizes reproducible tests, browser state exposure in dev, and replacing ad-hoc console checks with automated suites.

How this skill works

When a bug is reported, the skill attempts to reproduce it by writing an automated test that captures the failing behavior. If the test fails, debugging targets the logic; if it passes, the issue is likely in rendering/CSS or environment. The skill prescribes specific test types (unit, integration, time-progression, Playwright) and tactical checks (search for CSS transitions, expose window.__debug in dev) to quickly isolate the cause. It prioritizes regression and time-progression tests and warns against guessing or changing code without understanding.

When to use it

Investigating a reported bug, unexpected behavior, or visual flicker

When users report "not working", "broken", "glitch", or similar issues

Before asking users for manual checks—try to reproduce with an automated test first

When behavior diverges slowly over time (calculation drift)

When a UI shows stale data or frame-rate related flickering

Best practices

Automate first: write a failing test to reproduce the issue before asking the user questions

Isolate systematically: test calculation, rendering, browser differences, timing, and state independently

Use regression tests to lock fixes and time-progression tests to simulate many frames

Expose dev-only state (e.g., window.__debug) for quick browser inspection when needed

Avoid console.log-heavy guessing; prefer deterministic tests and Playwright for browser-specific checks

Example use cases

Write a unit test to confirm a computation algorithm using known inputs and expected outputs

Add a time-progression test to reproduce and measure drift after thousands of frames

Use Playwright to verify whether a visual glitch is browser-specific

Search CSS for transitions on frequently-updated elements and remove them to stop flicker

Expose window.__debug in dev to inspect live state values and derived computations

FAQ

What if I cannot reproduce the bug in tests?

Request precise reproduction steps and example inputs from the reporter, then write an integration or Playwright test that mirrors those steps.

When should I remove CSS transitions versus change logic?

If automated tests show correct values but the UI flickers or shows wrong visuals, suspect CSS transitions on frequently-updated elements and remove them; if tests fail, fix logic instead.

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

debugging

testing

automation

frontend

unit-tests

integration-tests

Trigger phrases

reproduce bug

write failing test

isolate bug

analyze state

verify inputs

run tests

check rendering

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
