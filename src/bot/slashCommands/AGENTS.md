# src/bot/slashCommands — operating manual

Dual-mode command layer. **This file owns the shared half of the slash/text pair.**
`../textCommands/AGENTS.md` points back here; the text-only half lives there.

Read the root `AGENTS.md` §8 for the add-a-command workflow and §2 for the gates. The
A-tier definitions (§0, §2.1) are not repeated here.

## 1. Every command ships twice

Ship a slash command **and** a `.`-prefixed text command. One family alone is a
half-feature, and users type both. Both delegate to the same builder in
`src/bot/builders/*Builders.ts` and return a `ResponseModel`.

## 2. The response layer is already single-copy. The argument layer is not.

**Do not deduplicate the command layer wholesale.** Measure before you believe any claim
either way. Counted over non-test `.ts` files:

- `src/bot/slashCommands/`: 34 files, **186** `.add*Option(` call sites, **149**
  `*Builders.x(` call sites, **77** distinct top-level command names.
- `src/bot/textCommands/`: 35 files, **0** `.add*Option(` call sites, **150**
  `*Builders.x(` call sites, **575** distinct names + aliases across **34** modules
  resolved in `textCommands/index.ts:43-76`.
- The two families share **34** builder modules. The only asymmetry is
  `AutopostBuilders`, used by the text family alone.

So the *response* layer is genuinely one copy, as the root claims. The *argument* layer
is disjoint by construction: 186 typed Discord option declarations on the slash side and
zero on the text side, against **82** hand-written string-grammar sites (`.match(`,
`.test(`, `new RegExp(`, `split(/\s+/)`, `startsWith('lfm:')`, `parseInt(`) spread
across **18** text files.

**The two argument models are different languages.** Typed Discord options versus
hand-written string grammars:

- `seek 1:30` / `seek 1:01:01` — `textCommands/music/musicCommands.ts:526-537` splits
  on `:` and accepts 2 or 3 parts. The slash twin is an integer option
  (`slashCommands/musicSlashCommands.ts:126`).
- `lfm:username` — `textCommands/lastfm/playCommands.ts:121-122` branches on a
  `startsWith('lfm:')` prefix. The slash twin declares a separate `lfm` **string
  option** and coerces it (`slashCommands/userSlashCommands.ts:61`, `:96`).
- `filters clear` / `reset` / `echo` — `musicCommands.ts:608-630` dispatches on a bare
  verb. There is no slash `filters` command at all.

A shared parser has to model both, which means it models neither cleanly, and each
unmodelled case becomes a divergence. **Fix concrete drift when you find it; do not
merge the layers.**

## 3. A live example of why: the layout token

`.fm <@123> mini` is **silently ignored**, and it is pinned as a bug rather than
accidentally fixed.

`playCommands.ts:100` calls `parseFmEmbedType(options)` on the **whole argument
string**. `parseFmEmbedType` only matches a bare token — its lists are exact values
(`src/domain/enums/fmEmbedType.ts:31-36`) — so the composite string parses to `null`,
the `if` at `playCommands.ts:102` is skipped, and the token is never stripped and never
applied. The user asks for a mini embed and receives the default. `lfm:name tiny` is
the same shape: it falls into the `startsWith('lfm:')` branch with the layout word still
attached.

The slash twin is unaffected — it reads a typed option
(`userSlashCommands.ts:62-70`).

The test that documents this is `textCommands/lastfm/playCommands.test.ts:478-495`. It
is a **behaviour lock**, not an endorsement: if you fix the parser, that test is what
has to change, deliberately and in the same commit.

## 4. Names must be unique, and the registry is last-write-wins

`textCommands/index.ts:86-99` — `claim()` overwrites the map and logs
`'Text command name collision — the later registration wins'`. Registration order is
the module array at `:42-77`. Two passes: canonical names first (`:101-106`), then
aliases, which only fill names nobody claimed (`:107-116`).

Two real incidents, both silent, both on the text side: `.remove` became queue-remove
instead of account-unlink, and `.lyrics` became music lyrics instead of the Last.fm
one. Account unlink and Last.fm lyrics were renamed `.unlink` and `.lyric` to resolve
it — `src/tests/commandRegistryInvariants.test.ts:13-16` and the regression lock at
`:218-228`.

Collision handling is also a **two-sided** decision, and both halves are pinned exactly:

- Aliases shared by two different commands: `['np: fm vs nowplaying', 'rm: fm vs remove']`
  (`:193`). `PlayCommands` sits 3rd and `MusicCommands` far later, so **the Last.fm
  `fm` command answers `.np` and `.rm` today**, not queue-remove and now-playing
  (`:170-181`).
- Aliases shadowed by another command's canonical name — the alias stays inert, and
  activates silently if the owner is ever renamed: `history`, `nowplaying`, `prefix`
  (`:211-215`).

`src/tests/commandRegistryInvariants.test.ts` is the gate for all of it. It reads names
out of the **source AST**, not from instantiated commands, so that the check does not
need the DI container. Its loud-failure rule matters: a computed (non-literal) command
name, or a literal with no `name`, **throws** rather than being skipped (`:92-106`).
Keep command names as string literals.

Slash side: only **top-level** builders are compared, and the discriminator is the
`new SlashCommandBuilder()` the chain is rooted in — `user`, `artist` and `album` are
legal subcommand names repeated across many parents, and a naive sweep reports 39 false
duplicates (`:235-239`). The floor assertion at `:291` exists so the chain-walk cannot
stop matching and pass vacuously.

## 5. Tests build a command class positionally

Read the constructor before you write a test or add a parameter. A `new` of a command
class inside a test is positional, so a new required parameter breaks every call site
at build time — and `npm test` alone will not tell you.

- `MusicSlashCommands` — `slashCommands/musicSlashCommands.test.ts:9-12` passes **2**
  args; production passes 4 (`startup.ts:625`). The trailing params are optional.
- `PlayCommands` — `textCommands/lastfm/playCommands.test.ts:219` passes **3**
  (`userService, lastfmRepository, updateService`), matching `startup.ts:659`.
- `ChartCommands` — `chartCommands.test.ts:123` passes **5**; `:512` passes **4** and
  works, so the tail is optional.

Two positional traps worth knowing:

- `prisma` is the **seventh** parameter of `TrackService`, not the first or the fifth.
  Passing it first compiles when the rest are `as never`, and then every query fails
  inside the service's own catch — indistinguishable from "this user has no plays"
  (`src/bot/services/trackService.db.test.ts:25-31`).
- Discriminating a command literal from an arbitrary object: a command has
  `executeAsync` or `execute` **and** no spread. `musicCommands` writes
  `{ ...def, executeAsync: ... }`, and counting a spread literal as a definition
  double-counts the name and manufactures a false clash
  (`commandRegistryInvariants.test.ts:80-88`).

## 6. Dead code in this subtree

- A builder assembled through a helper rather than
  `new SlashCommandBuilder().setName(...)` is not matched by the duplicate sweep
  (`:285-290`). If you add a top-level command that way, it is invisible to the check.
- `getSlashCommandPayloads()` is the whole-registry read, for the same reason
  `getTextCommands()` exists: a single-name lookup cannot express "no two of these
  collide" (`textCommands/index.ts:127-138`).
