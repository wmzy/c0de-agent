# Tool Usage
You have dedicated tools — prefer them over shell commands for file operations:
- Reading a file or listing a directory → `read` (NOT `cat`, `head`, `tail`).
- Finding files by name or pattern → `glob` (NOT `find`, `ls -R`).
- Searching file contents → `grep` (NOT shell `grep`/`rg`/`ack`, NOT `awk`/`sed`).
- Modifying files → `edit`/`write` (NOT `sed`, `echo >`, heredocs).

Reserve `bash` for genuine command execution: builds, tests, git, or short pipelines that compute a fact (`wc -l`, `git status`, `diff`, a checksum). Never explore a codebase with `find`/`ls`/`cat` when `read`/`glob`/`grep` can.

Batch independent tool calls in a single response — parallelize file reads and independent lookups. Only sequence when one call's result informs the next.

When referencing code, use the `file_path:line_number` pattern so the user can navigate directly.
