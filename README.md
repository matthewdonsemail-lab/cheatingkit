# cheatingkit

> Reverse engineer anything. Take it apart, change its shape, run it somewhere else.

**Status:** outline / draft. This file is the source of truth for what the service is meant to do. The website in `index.html` is a minimal rendering of the same idea.

---

## 1. What this is

A new service being built in public. It helps people reverse-engineer a thing — a game, a community, a system — and then put the result into a different form, including onto a custom OS.

The writing rule is the opposite of the usual one: **make the wording less complicated, not more.** If a sentence needs a glossary, rewrite it.

## 2. What it should let someone do

1. **Take a community apart.** See how a game or community is put together, piece by piece, including the parts nobody wrote down.
2. **Change the modality.** Take a game and make it work in a different form without losing what made it work.
3. **Carry it to a custom OS.** Move the result onto the system the person actually runs.
4. **Rewrite the complicated bit.** Dense input in, short version out.

## 3. Principles

- Start with the thing in front of you, not with the tooling.
- Say hard things in short sentences.
- Every answer ends somewhere runnable — not in an archived note.
- Minimal by default: no build step, no dependency tree, no jargon wall.

## 4. Current shape of the repo

```
cheatingkit/
├── index.html   # the whole site: HTML + inline CSS, no build step
└── README.md    # this outline
```

The site is deliberately one file. Styles are inline in a `<style>` block with CSS variables; there is no framework, no package manager, and no remote dependency.

## 5. Design reference

The visual language is lifted from [opencode.ai](https://opencode.ai) — computed values captured from the live page, not guessed:

| Token | Value |
| --- | --- |
| Base background | `#0c0c0c` |
| Surface / band | `#1a1a1a` |
| Raised | `#161616` |
| Hairline | `#242424` |
| Primary text | `#fafafa` |
| Muted text | `#aeaeae` |
| Dim text | `#8f8f8f` |
| Accent green | `#54d483` (used at 40% on the source) |
| Link blue | `#6b8fff` |
| Headings / nav | monospace, 400 weight, tight tracking |
| Body | Inter / system sans, 17px, 1.55 line height |
| H1 | 48px, line-height 1.05, `-0.03em` |
| Corners | square — `0px` radius throughout |

Layout posture: flat stacked sections separated by hairlines, left-aligned, one idea per section. No cards, no gradients, no decorative icons.

## 6. Still undecided

- [ ] The first real target: which game or community do we take apart first?
- [ ] Repo remote / clone URL (the site currently shows a placeholder).
- [ ] What "different modalities" means concretely — list the actual formats.
- [ ] Which custom OS is the first destination.
- [ ] Whether this stays a written outline or grows a working service.

## 7. Run it locally

```bash
git clone <your-fork-url> cheatingkit
cd cheatingkit
open index.html
```

Works offline. Opens directly in a browser.
