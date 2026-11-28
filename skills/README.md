# skills

Copies of Claude skills kept in this repo so they can be uploaded or re-used.

## `anthropic/` (14 skills, Apache License 2.0)

Copied unmodified on 28 Nov 2026 from the synced skills folder of the Claude session, each with its own `LICENSE.txt` kept next to it. Only skills whose bundled `LICENSE.txt` is Apache 2.0 were copied.

algorithmic-art, brand-guidelines, canvas-design, docx, internal-comms, learn, mcp-builder, pdf, pptx, skill-creator, slack-gif-creator, theme-factory, web-artifacts-builder, xlsx

To use one in Claude Code, copy its folder to `.claude/skills/<name>/` (or zip the folder and upload it under claude.ai Settings, Skills). They are kept here, not in `.claude/skills/`, so they do not auto-load twice.

## Not copied, and why

| Skill | Reason |
|---|---|
| computer-use, chrome-browser, built-in-browser | Their `LICENSE.txt` forbids it: users may not "retain copies of these materials outside the Services", "reproduce or copy", or "distribute ... to any third party". |
| deep-research, diagram-explain-review, diagram-to-work-items, diagram-vs-page-check, doc-coauthoring, docs, google-workspace, import-memory, morning | No `LICENSE.txt` in the folder, so no redistribution right is stated. |
| code-review, run, run-skill-generator, simplify, init and other bundled commands | Built into Claude Code, not synced files. Nothing to copy. |

## Project skills

- `image-service/.claude/skills/run-image-service/`: our own skill for building, running and smoke-testing the image-service Worker.
