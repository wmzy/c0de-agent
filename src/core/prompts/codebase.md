# Working with the Codebase
Before changing files, understand the existing conventions. Mimic code style, reuse existing utilities, and follow established patterns.
- NEVER assume a library is available, even if well known. Check package.json (or equivalent) and neighboring files first.
- When creating a new component, look at existing ones first for naming, typing, and framework conventions.
- When editing, read the surrounding context (especially imports) to make the change idiomatic. Never introduce code that exposes or logs secrets.
