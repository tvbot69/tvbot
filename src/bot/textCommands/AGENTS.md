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

Measured across these 35 non-test files: **zero** `.add*Option(` call sites, against
**186** on the slash side, and **82** hand-written string-grammar sites (`.match(`,
`.test(`, `new RegExp(`, `split(/\s+/)`, `startsWith('lfm:')`, `parseInt(`) in **18**
files. Shapes you will meet:

- `seek 1:30`, `seek 1:01:01` — `music/musicCommands.ts:526-537`
- `lfm:username` — `lastfm/playCommands.ts:121-122`, also `topCommands.ts`,
  `genreCommands.ts`, `countryCommands.ts`, `overviewCommands.ts`
- `filters clear` — `music/musicCommands.ts:608-630`, bare verb, no slash twin
- `<@123>` / `<@!123>` mentions — `lastfm/playCommands.ts:108`

## Parse on the whole argument string, and know what that costs

`parseFmEmbedType(options)` is called on the **entire** argument string
(`lastfm/playCommands.ts:100`), and the predicate only matches a bare token — its lists
are exact values (`src/domain/enums/fmEmbedType.ts:31-36`). So `.fm <@123> mini`
parses to `null`, the `if` at `:102` is skipped, and the token is neither stripped nor
applied: the user asked for a mini embed and silently received the default.
`lfm:name tiny` has the same shape.

This is a **pinned bug**, not an endorsement —
`lastfm/playCommands.test.ts:478-495` asserts the broken behaviour so a fix has to be
deliberate. The slash twin reads a typed option and is unaffected
(`../../slashCommands/userSlashCommands.ts:62-70`). Use it as your worked example of why
the two parsers stay separate.

## The registry is last-write-wins, and both passes are pinned

`index.ts:86-99` is the whole mechanism; the module array at `:42-77` is the order.
Canonical names register first, aliases only fill names nobody claimed
(`:101-116`). Every remaining collision is logged as
`'Text command name collision — the later registration wins'`.

Three facts the gate pins, each of which is a live behaviour rather than an accident:

- `.np` and `.rm` answer as the Last.fm `fm` command, not as now-playing and
  queue-remove (`src/tests/commandRegistryInvariants.test.ts:170-181`).
- `history`, `nowplaying` and `prefix` are aliases shadowed by another command's
  canonical name. They are inert **and latent**: rename the owner and one activates
  silently with different behaviour (`:196-216`).
- `.remove` / `.lyrics` are owned by the music commands, `.unlink` / `.lyric` by the
  Last.fm ones (`:218-228`). Do not reintroduce the old spellings.

A name or alias containing a dot or whitespace can never match, because the prefix is
added by the dispatcher (`:161-168`).

## Registration is `container.resolve`, not the constructor

`index.ts:43-76` resolves 34 command modules. Production wiring is manual and
positional in `src/bot/startup.ts` — `PlayCommands` at `:657-660`, `ChartCommands` at
`:663-666`, `MusicCommands` at `:624`. `getTextCommands()` returns the **live** map;
callers must not mutate it (`index.ts:139-144`).

## Dead code in this subtree

A command whose name is computed rather than a string literal is skipped by
`src/tests/commandRegistryInvariants.test.ts` — the extractor **throws** on a
non-literal `name` or `aliases` value (`:98-123`) rather than skipping it, so a
computed name breaks the suite loudly. Keep names as literals.

The vacuum test at `:140-146` exists so a silently non-matching extractor cannot make
every other assertion pass for the wrong reason. If you change how commands are
declared here, that test is your first evidence.
