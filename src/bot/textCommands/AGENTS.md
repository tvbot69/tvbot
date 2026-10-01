# src/bot/textCommands — operating manual

The `.`-prefixed half of the dual-mode command layer.

**The shared half lives in `../../slashCommands/AGENTS.md`.** Read it first. It owns:

- the dual-mode rule (every command ships twice, through `src/bot/builders/`),
- the measured overlap numbers and why the argument parsers must **not** be deduplicated,
- the name-collision registry and the two real incidents,
- the positional-constructor test contract.

Do not restate any of it here. What follows is what is specific to this subtree.

## This is where the hand-written argument grammars live

A text command receives `args: string[]` and must parse it itself. That is the whole
reason the two families are not mergeable, and it is where defects that a typed option
cannot have come from.

Measured across these 34 non-test files: **zero** `.add\w*Option(` call sites, against
**184** on the slash side, and **81** hand-written string-grammar sites (`.match(`,
`.test(`, `new RegExp(`, `split(/\s+/)`, `startsWith('lfm:')`, `parseInt(`) in **18**
files. Shapes you will meet:

- `seek 1:30`, `seek 1:01:01` — `music/musicCommands.ts:530-538`
- `lfm:username` — `lastfm/playCommands.ts:151-152`, also `topCommands.ts`,
  `genreCommands.ts`, `countryCommands.ts`, `overviewCommands.ts`
- `filters clear` — `music/musicCommands.ts:628-635`, bare verb, no slash twin
- `<@123>` / `<@!123>` mentions — `lastfm/playCommands.ts:138`

## The layout token: a grammar defect that shipped, and what the fix had to respect

`parseFmEmbedType` matches **bare tokens only**; its lists are exact values
(`src/domain/enums/fmEmbedType.ts:31-36`). `.fm` used to hand it the **entire** argument
string (`lastfm/playCommands.ts`), so `.fm <@123> mini` parsed to `null`, the branch was
skipped, and the token was neither stripped nor applied: the user asked for a mini embed
and silently received the default. `lfm:name tiny` had the same shape. The slash twin was
never affected — it reads a typed choice (`../../slashCommands/user/userSlashCommands.ts:62-69`),
so there is no position for a token to be misplaced in.

Both the fix and the trap it had to avoid are in the code at
`lastfm/playCommands.ts:118-136`:

- the token is read from the **tail** of the argument list, which is what makes
  `.fm <@123> mini` and `.fm mini` behave identically;
- it is removed by a **length slice**, not by `replace(/mini/i, '')`. The obvious repair
  is worse than the bug: `mini` and `minidisco` are real Last.fm usernames, so a global
  replace turns `lfm:mini` into `lfm:` — an empty target, which searches the **caller's
  own account** and answers with a wrong track for a valid request, with no error.

`lastfm/playCommands.test.ts:505-582` pins all three directions, and the two negatives
are the point: a non-layout argument after a mention changes **nothing** (`:538-553`),
and a username that merely *contains* a layout word survives whole (`:565-581`). A test
that only asserted the fix would also have passed on the `replace` version.

Use this as the worked example of why the two parsers stay separate: a typed option
arrives carrying its own grammar, arity and validation, and a string grammar has to be
re-derived at every call site.

## The registry is last-write-wins, and both passes are pinned

`index.ts:84-97` is the whole mechanism; the module array at `:41-75` is the order
(33 modules). Canonical names register first (`:99-104`), aliases only fill names nobody
claimed (`:105-114`). Every remaining collision is logged as
`'Text command name collision — the later registration wins'`.

Three facts the gate pins, each of which is a live behaviour rather than an accident:

- `.np` and `.rm` answer as the Last.fm `fm` command, not as now-playing and
  queue-remove (`src/__tests__/commandRegistryInvariants.test.ts:170-181`).
- `history`, `nowplaying` and `prefix` are aliases shadowed by another command's
  canonical name. They are inert **and latent**: rename the owner and one activates
  silently with different behaviour (`:211-215`).
- `.remove` / `.lyrics` are owned by the music commands, `.unlink` / `.lyric` by the
  Last.fm ones (`:218-228`). Do not reintroduce the old spellings.

A name or alias containing a dot or whitespace can never match, because the prefix is
added by the dispatcher (`src/bot/handlers/commands/commandHandler.ts:197-203`).

## Registration is `container.resolve`, not the constructor

`index.ts:41-75` resolves 33 command modules. Production wiring is manual and
positional in `src/bot/startup.ts` — `PlayCommands`, `ChartCommands` and
`MusicCommands` are each built by a `new <Class>(...)` expression there. Those three are
cited by expression rather than by line because `startup.ts` is the file most often
reshuffled, and a stale line number is worse than a nameable expression.
`getTextCommands()` returns the **live** map; callers must not mutate it
(`index.ts:137-142`).

## Dead code in this subtree

A command whose name is computed rather than a string literal is skipped by
`src/__tests__/commandRegistryInvariants.test.ts` — the extractor **throws** on a
non-literal `name` or `aliases` value (`:98-123`) rather than skipping it, so a
computed name breaks the suite loudly. Keep names as literals.

The vacuum test at `:140-146` exists so a silently non-matching extractor cannot make
every other assertion pass for the wrong reason. If you change how commands are
declared here, that test is your first evidence.
