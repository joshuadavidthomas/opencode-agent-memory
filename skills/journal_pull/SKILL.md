---
name: journal_pull
description:  How to search and retrieve existing journal entries for context preservation across sessions.
---

# Journal Access & Discovery Skill

**Purpose**: How to search and retrieve existing journal entries for context preservation across sessions.

**Tools Available**: use `journal_list`, `journal_search`, `journal_read` tools given by opencode-agent-memory plugin

---

## When to Use Journal Search

### ✅ DO search when:

- **Start of new task**: Understand what's been tried before (avoid reinventing)
- **Debugging session**: Find past attempts that failed/succeeded
- **Architecture decisions**: Recall prior tradeoff discussions
- **Codebase onboarding**: Learn why certain patterns exist
- **Continuation work**: Follow up on incomplete investigations

### ❌ DON'T search when:

- Single obvious keyword query (use direct tools like grep instead)
- Looking for live code examples (use AST grep / lsp_find instead)
- Session is fresh start with no prior context

---

## Tool Selection Guide

```
┌─────────────────────┬──────────────────────────────────────┐
│ Tool                │ Use Case                             │
├─────────────────────┼──────────────────────────────────────┤
│ journal_list        │ "Show me recent entries, give me X"  │
│                     │ First step in any research workflow  │
├─────────────────────┼──────────────────────────────────────┤
│ journal_search      │ "Find 'JWT token storage', limit 10" │
│                     │ Semantic matching for ideas/topics   │
├─────────────────────┼──────────────────────────────────────┤
│ journal_read        │ "Read entry ID 20260310-XXXXXXX"     │
│                     │ Full content retrieval               │
└─────────────────────┴──────────────────────────────────────┘
```

---

## Standard Workflow Pattern

### Pattern 1: Broad Discovery → Narrow Search → Deep Dive

```typescript
// Step 1: Recent activity scan
entries = journal_list(limit=10)

// Identify relevant themes from titles/tags

// Step 2: Focused semantic search
results = journal_search(query="JWT token expiration", limit=8)

// Step 3: Read full entries for context
for entry_id in results:
    full_entry = journal_read(id=entry_id)
    // Extract decision rationale, code examples, follow-ups
```

### Pattern 2: Specific Investigation

```typescript
// Direct targeted search
findings = journal_search(
    query="build system cmake migration failure",
    tags="refactor,build-system",
    limit=5
)

// Optional: Cross-reference with specific date range via journal_list first
recent = journal_list(from_date="2026-03-01", to_date="2026-03-10")

// Then read relevant entries
critical_entry = journal_read(id=findings[0].id)
```

---

## journal_list Usage

**Signature**:
```typescript
journal_list(limit?: number, from_date?: string, to_date?: string, project_path?: string)
```

**Common Patterns**:

```typescript
// Most recent 10 entries (default behavior)
all_recent = journal_list(limit=10)

// From last week only
this_week = journal_list(limit=20, from_date="2026-03-03")

// Check project-specific entries
proj_entries = journal_list(limit=15, project_path="/path/to/project")
```

**Output Format**:
```markdown
| Entry ID | Messages | First Date | Last Date | Tags |
|----------|----------|------------|-----------|------|
| ses_abc123 | 45 | 2026-03-10 | 2026-03-10 | refactor, build-system |
| ses_def456 | 12 | 2026-03-09 | 2026-03-09 | bugfix, auth |
```

---

## journal_search Usage

**Signature**:
```typescript
journal_search(
    text?: string,           // Required: semantic search query
    tags?: string,           // Optional: comma-separated tag filter
    limit?: number,          // Default/max: 100 (set lower for speed)
    offset?: number,         // Paginate through results
    project?: string         // Optional: project scope filter
)
```

**Query Best Practices**:

### ✅ Good Queries

| Query | Returns |
|-------|---------|
| "JWT security token storage" | Matches entries discussing JWT + storage approaches |
| "build system failing macOS" | Finds CI failures across platforms |
| "error handling pattern async" | Locates error handling discussion for async code |

### ⚠️ Poor Queries

- Single generic terms: `"auth"` → Too broad, use `"authentication implementation"`  
- Keyword stuffing without logic: `"try catch null pointer exception"` → Unnatural phrasing
- Vague intent: `"what do you think about this"` → No semantic meaning

### Tag Filtering

Use exact tag names from known taxonomy:
```typescript
// Only entries tagged with both 'debugging' AND 'memory-leak'
results = journal_search(query="heap corruption", tags="debugging,memory-leak")

// Only debugging-tagged entries
debug_only = journal_search(query="", tags="debugging", limit=20)
```

**Note**: Empty string `""` for `text` means "match all; just apply tag filters"

---

## journal_read Usage

**Signature**:
```typescript
journal_read(id: string)
```

**When to Use**: After search/list identified candidate entries

**Output Structure**:
```markdown
Entry ID: [date]-[timestamp]-[hash]
Title: <Concise Summary>  
Created: 2026-03-10T14:23:32.998Z  
Tags: [tag1, tag2, tag3]

[Full journal content here...]
```

**Pro Tip**: Always check `Date` field—older entries might be superseded by newer research.

---

## Advanced Patterns

### Pattern A: Timeline Reconstruction

Reconstruct how a problem evolved over multiple sessions:

```typescript
// Get all debugging entries in date range
debug_histories = journal_list(from_date="2026-03-01", limit=50)

// Filter for relevant tag
relevant = debug_histories.filter(e => e.tags.includes('debugging'))

// Chronological read
for entry in relevant.sort(by_date):
    history = journal_read(id=entry.id)
    // Track what worked/failured at each stage
```

### Pattern B: Cross-Pattern Comparison

Compare different implementations discussed:

```typescript
// Find architecture discussions on same topic
patterns_a = journal_search(query="C++ RAII resource management")
patterns_b = journal_search(query="smart pointers ownership model", limit=5)

// Read both sets
read_all(patterns_a + patterns_b)
// Extract comparison table: pros/cons, tradeoffs, recommendations
```

### Pattern C: Decision Traceback

For "Why was this value changed?":

```typescript
// Start with symptom
search_results = journal_search(
    query="token validation timeout configuration",
    tags="config,security"
)

// Read backward chronologically until root cause found
for result in reverse_order(search_results):
    decision = journal_read(result.id)
    if "rationale" or "reasoning" appears in content:
        capture_decision_trail()
        break
```

---

## Search Optimization Tips

### Increase Relevance
- Add specificity: `"async await race condition"` > race condition
- Include domain context: `"NVRHI Vulkan buffer upload"` vs `"buffer upload"`
- Use quotes for phrases: `"httpOnly cookie"` matches exact term

### Handle Noise
- Results with low relevance score (<30%) → Refine query or increase specificity
- Duplicate findings → Use `offset` parameter to paginate
- Irrelevant hits → Add tag filter to narrow scope

### Pagination Strategy
```typescript
// Page 1: most relevant
page1 = journal_search(query="X", limit=20, offset=0)

// Page 2 if page1 insufficient
page2 = journal_search(query="X", limit=20, offset=20)
```

---

## Integration with Other Tools

### Combined Workflow Example

```typescript
// User requests: "Why does our JWT expire so quickly?"

// Step 1: Scope search
expirations = journal_search(query="JWT token lifetime expiry policy", limit=10)

// Step 2: If no direct answer, broaden investigation
if expirations.is_empty():
    # Look for related auth changes
    auth_changes = journal_search(
        query="JWT implementation authentication middleware", 
        limit=15
    )
    
    # Scan for mentions of "expiry" or "timeout" in related content
    
// Step 3: Verify against actual code
relevant_files = [e.file_references for e in expirations]
code_context = read_multiple_files(relevant_files)
```

### Cross-Reference Strategy

When journal gives vague direction:
1. Extract mention of files/concepts from journal entry
2. Use `grep_app_searchGitHub` or `ast_grep_replace` to find concrete examples
3. Use `lsp_diagnostics` to verify current implementation state

---

## Common Mistakes to Avoid

### ❌ Over-reliance on journal alone
Journal captures decisions but not always final implementation details. Cross-check with code reads.

### ❌ Assuming freshness equals accuracy
Older entries may reflect deprecated patterns. Check dates vs current docs.

### ❌ Not filtering by tags properly
Without tag constraints, searches return too much irrelevant chatter.

### ❌ Skipping read for context
Search preview snippets often lack critical detail. Always call `journal_read()` for candidates.

---

## Quick Reference

**Goal → Tool Chain**:

| Goal | Recommended Path |
|------|------------------|
| See what got done recently | `journal_list(limit=10)` |
| Find "how JWT expiration works" | `journal_search("JWT token expiration policy")` then `journal_read()` |
| Review all debugging attempts for specific bug | `journal_search(query="bug-id-123", tags="debugging")` |
| Get architectural timeline | `journal_list(from_date="...", to_date="...")` → read all |
| Verify current state matches past decisions | `journal_search(description) + read(file_paths mentioned)` |

---

**Last Updated**: 2026-03-10  
**Owner**: Sisyphus Agent Protocol