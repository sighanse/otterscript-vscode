# Changelog

## [0.1.1] - 2026-04-XX

### Added

- Extended documentation for syntax-only constructs (swim strings, template tags, map/vector expressions).
- Richer ProGet-specific variable documentation, including availability notes and examples.
- Improved documentation coverage for scalar and vector functions, including clearer parameter descriptions and examples.

### Changed

- Hover provider fully refactored:
  - Unified rendering via a shared Markdown builder.
  - Correct suppression of hover inside strings and comments.
- Completion providers refactored for consistency and maintainability:
  - Centralized completion item construction.
  - Improved sorting and prioritization across keywords, operations, functions, and variables.
  - More accurate snippet insertion without guessing function signatures.
- Signature help significantly improved:
  - Supports scalar functions, vector functions, and operations.
  - Handles nested parentheses and complex argument expressions.
  - More reliable active-parameter tracking.
- Documentation model normalized:
  - Syntax documentation now uses the same structured format as functions and keywords.
  - Removed redundant or duplicated documentation text across entries.

### Fixed

- Removed stale diagnostic markers when closing files.
- Prevented hover and completion from triggering inside string literals and comments.
- Corrected snippet definitions for several scalar functions.
- Fixed keyword hover regressions caused by overly broad word matching.
- Improved error recovery and stability when documentation entries are incomplete or optional.

## [0.1.0] - 2026-04-13

### Added

- Syntax highlighting
- Function signatures and hover information
- Code snippets
- Basic validation
