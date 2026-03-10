---
name: journal_push
description:  Auto-generate session-ending journal entries that capture work completed, decisions made, and learnings accumulated during a conversation.documentation, architecture guides, or technical deep-dives.
---

# Session Journal Summarization Skill

**Purpose**: Auto-generate session-ending journal entries that capture work completed, decisions made, and learnings accumulated during a conversation.

**Tools Available**: use ```journal_write``` tools given by opencode-agent-memory plugin

**Trigger**: At end of every agent session where meaningful work was performed.

---

## When to Write

Write a journal entry when ANY of these apply or user requested:

- ✅ Files were modified or created
- ✅ Research/investigation yielded insights
- ✅ Design/technical decisions were made
- ✅ Bugs were diagnosed or fixed
- ✅ Plans/approaches were proposed and evaluated
- ⚠️ **Skip**: Trivial chats, clarification-only conversations with no actionable outcomes

---

## Suggested Structure

### Title Format
```
<YYYYMMDD>-<HHMMSS>-<SHORT_HASH> | <Concise Summary>
```

Example: `20260310-142332-998 | NVRHI Build Script Optimized`

### Header (mandatory)
```markdown
[Date Range]: 2026-03-10T10:15:00Z to 2026-03-10T14:45:30Z  
Duration: ~4h 30m  
Files Changed: X (`path/file.ext`, `path/foo.bar`)  
Status: Completed / In Progress / Blocked

Tags: [action-category], [tech-domain], [optional-specific-tag]
```

### Core Sections (in order)

#### 1. Summary
1-3 sentences on what was accomplished. Be specific.

❌ **Poor**: "Worked on build system."  
✅ **Good**: "Refactored NVRHI build script to use CMake multi-config generator instead of manual VS project selection, reducing configuration time by ~70%."

#### 2. Key Takeaways / Decisions Made
Bullet list of important conclusions:

- Decision + rationale
- Alternative considered and rejected
- Hidden complexity discovered
- Pattern confirmed or invalidated

#### 3. Changes Made (files & scope)
```markdown
| File | Change Type | Why |
|------|-------------|-----|
| ... | added/modified/deleted | Brief justification |
```

#### 4. Challenges Encountered
What was non-trivial? What did you struggle with?

- Problem description → Investigation approach → Solution pattern used

#### 5. Outstanding Questions / Next Steps
- Unresolved issues
- Follow-ups needed (by whom?)
- TODOs for future sessions

---

## Tag Conventions

Use 2-4 tags total:

**Action Category** (required): `bugfix`, `feature`, `refactor`, `investigation`, `learning`, `architecture`, `perf`, `testing`

**Domain** (1-2 tags): `graphics-api`, `build-system`, `auth`, `frontend-ui`, `database`, `compiler-toolchain`

**Specific** (optional if domain is clear): `cmake`, `vs-project`, `jwt-auth`, `react-hooks`

Examples:
- `bugfix, graphics-api, nvrhi`
- `refactor, build-system, cmake`
- `investigation, auth, jwt-security`

---

## Output Location & Formatting

**Directory**: `./journal_push/session_<TIMESTAMP>.md` (pre-created by push script)  
OR  
If push mechanism doesn't exist yet: write to `./journal_push/<CONCISE_TITLE>.md`

**Format**: Plain Markdown with headers. No YAML frontmatter. Keep it readable raw.

**Line length**: Maximum ~120 chars wrapped naturally

---

## Quality Standards

### ✅ Good Entry
- Concrete, measurable outcomes
- Clear decision rationales
- Specific file paths and changes
- Honest about challenges and failures
- Actionable next steps

### ❌ Poor Entry
- Vague descriptions ("fixed issue", "improved code")
- No traceability (what files, why changed)
- Missing context for decisions
- Too long (>80 lines) or too short (<5 substantive lines)
- Copies/pastes logs verbatim without analysis

---

## Example Entry

```markdown
## 20260310-142332-998 | NVRHI Build System Migration

**Date Range**: 2026-03-10T10:15:00Z to 2026-03-10T14:45:30Z  
**Duration**: ~4h 30m  
**Files Changed**: 3 (`tools/build/nvrhi_cmake/CMakeLists.txt`, `README.md`, `.gitignore`)  
**Status**: Completed

**Tags**: `refactor, build-system, cmake`

---

### Summary
Migrated NVRHI from Visual Studio solution-based build to pure CMake multi-config generator, eliminating manual IDE configuration and enabling CI builds on Linux/Mac without VS installer requirement.

### Key Takeaways
- CMake's `GENERATOR_EXPRESSION` syntax handles platform-specific flags elegantly
- `VS_PROJ.sln` parsing can be brittle—better to generate CMakeLists.txt directly
- Existing `nvrhi.vcxproj.filters` dependency forced rework of resource binding logic
- Build time reduced from 8min → 2.5min with parallel `-j8` config

### Changes Made

| File | Change Type | Why |
|------|-------------|-----|
| `tools/build/nvrhi_cmake/CMakeLists.txt` | created | New CMake build definition with multi-platform support |
| `README.md` | modified | Updated build instructions section to document CMake workflow |
| `.gitignore` | modified | Added CMake-generated file patterns |

### Challenges Encountered
**Problem**: Resource compiler (rc.exe) couldn't find embed path in cross-config build.  
**Investigation**: Discovered CMake's `RC_FLAGS` wasn't propagating to sub-targets properly.  
**Solution**: Used `add_custom_command()` with explicit `INPUT`/`OUTPUT` dependencies for resource compilation step.

**Problem**: Old MSBuild target properties leaked into CMake targets.  
**Investigation**: Found `platform_toolset` hardcoded in legacy config files.  
**Solution**: Stripped manual property injection; moved all configs to generator expressions.

### Outstanding Questions / Next Steps
- [ ] Migrate existing CI pipeline to CMake (track: #issue-127)
- [ ] Verify macOS Metal backend still compiles correctly
- [ ] Document custom CMake modules for contributors in `/docs/build-guide.md`
```

---

## Implementation Notes for Agents

1. **Don't force it** — If session was purely clarifying questions with zero output, skip journaling.

2. **Be honest about failures** — Note bugs found, attempts that didn't work, things left incomplete. This is valuable for future debugging.

3. **Preserve context across sessions** — Use journal as persistent memory. Future you will thank current you.

4. **Batch related entries** — If doing multiple small fixes to same module, combine into one coherent entry rather than fragmented micro-entries.

5. **Verify before writing**:
   - All modified files listed?
   - Tags are categorical not random?
   - Outcomes are measurable?
   - Next steps have owner/due date if applicable?

---

**Last Updated**: 2026-03-10  
**Owner**: Sisyphus Agent Protocol