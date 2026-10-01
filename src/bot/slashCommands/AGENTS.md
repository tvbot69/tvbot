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
either way. Counted over non-test `.ts` files, re-measured 2026-09-30 (the method is in
the table, so re-run it rather than trusting it):

| | `src/bot/slashCommands/` | `src/bot/textCommands/` (recursive) |
|---|---|---|
| non-test `.ts` files | **33** | **34** |
| `.add\w*Option(` call sites | **184** | **0** |
| `\w+Builders\.\w+(` call sites | **147** | **149** |
| distinct command names | **76** top-level (`new SlashCommandBuilder()` fluent chain, the same walk `commandRegistryInvariants.test.ts:246-276` does) | **570** names + aliases across **33** resolved modules (`textCommands/index.ts:41-75`) |
| hand-written string-grammar sites | 20 in 8 files | **81** in **18** files |

String-grammar sites are `.match(`, `.test(`, `new RegExp(`, `split(/\s+/)`,
`startsWith('lfm:')`, `parseInt(`.

So the *response* layer is genuinely one copy: of the 38 non-test modules in
`src/bot/builders/`, **33** are used by both families and exactly one —
`autopostBuilders` — is used by the text family alone. The *argument* layer is disjoint
by construction: 184 typed Discord option declarations on the slash side and zero on the
text side, against 81 hand-written string-grammar sites in 18 text files.

**The two argument models are different languages.** Typed Discord options versus
hand-written string grammars:

- `seek 1:30` / `seek 1:01:01` — `textCommands/music/musicCommands.ts:530-538` splits
  on `:` and accepts 2 or 3 parts. The slash twin is an integer option
  (`slashCommands/music/musicSlashCommands.ts:128-130`).
- `lfm:username` — `textCommands/lastfm/playCommands.ts:151-152` branches on a
  `startsWith('lfm:')` prefix. The slash twin declares a separate `lfm` **string
  option** (`slashCommands/user/userSlashCommands.ts:61`) and coerces it (`:96`).
- `filters clear` / `reset` / `echo` — `musicCommands.ts:628-635` dispatches on a bare
  verb. There is no slash `filters` command at all.
- `<@123>` / `<@!123>` mentions — `playCommands.ts:138`.

A shared parser has to model both, which means it models neither cleanly, and each
unmodelled case becomes a divergence. **Fix concrete drift when you find it; do not
merge the layers.**

## 3. A worked example: the layout token, found and fixed

A hand-written grammar has failure modes a typed option cannot have. This one shipped,
was found, and is now fixed — it is the worked example, in the form that is still true.

`parseFmEmbedType` matches **bare tokens only**; its lists are exact values
(`src/domain/enums/fmEmbedType.ts:31-36`). `.fm` was handing it the **whole** argument
string, so `.fm <@123> mini` parsed to `null`: the branch was skipped, the token was
neither applied nor stripped, and the user asked for a mini embed and got the default.
`lfm:name tiny` had the same shape. The slash twin never had it — it reads a typed
choice (`slashCommands/user/userSlashCommands.ts:62-69`), so there is no position for the
token to be in the wrong place.

The fix, and the two things it had to be careful about
(`textCommands/lastfm/playCommands.ts:118-136`):

- **Read the token from the TAIL of the argument list**, not from the whole string — the
  same shape `lfm:` is read with fifteen lines below. That is what makes
  `.fm <@123> mini` and `.fm mini` behave identically.
- **Remove it by a LENGTH slice, not by replacement.** The obvious repair,
  `options.replace(/mini/i, '')`, is worse than the bug it fixes: `mini` and `minidisco`
  are both real Last.fm usernames, and a global replace turns `lfm:mini` into `lfm:` — an
  empty target that searches the **caller's own account** and answers with a wrong
  track for a perfectly valid request, with no error anywhere. A length slice can only
  drop the tail it just matched.

Both directions are pinned, because a test that only asserted the fix would also pass on
the `replace` version (`textCommands/lastfm/playCommands.test.ts:505-582`):

- a token after a mention applies **and** is stripped, so the mention still resolves
  (`:517-536`);
- an argument that is **not** a layout token changes **nothing**, which is what stops the
  fix from becoming a shredder (`:538-553`);
- a username that merely **contains** a layout word survives whole — `lfm:mini` and
  `lfm:minidisco` both reach Last.fm as themselves (`:565-581`).

That is the argument in one paragraph: a typed option arrives carrying its own grammar,
its own arity and its own validation. A string grammar has to be re-derived at every call
site, and a word that is only *sometimes* a keyword is a defect waiting for the first
user who puts it in the wrong position.

## 4. Names must be unique, and the registry is last-write-wins

`textCommands/index.ts:84-97` — `claim()` overwrites the map and logs
`'Text command name collision — the later registration wins'`. Registration order is
the module array at `:41-75`. Two passes: canonical names first (`:99-104`), then
aliases, which only fill names nobody claimed (`:105-114`).

Two real incidents, both silent, both on the text side: `.remove` became queue-remove
instead of account-unlink, and `.lyrics` became music lyrics instead of the Last.fm
one. Account unlink and Last.fm lyrics were renamed `.unlink` and `.lyric` to resolve
it — `src/__tests__/commandRegistryInvariants.test.ts:13-16` and the regression lock at
`:218-228`.

Collision handling is also a **two-sided** decision, and both halves are pinned exactly:

- Aliases shared by two different commands: `['np: fm vs nowplaying', 'rm: fm vs remove']`
  (`:193`). `PlayCommands` sits 3rd and `MusicCommands` far later, so **the Last.fm
  `fm` command answers `.np` and `.rm` today**, not queue-remove and now-playing
  (`:170-181`).
- Aliases shadowed by another command's canonical name — the alias stays inert, and
  activates silently if the owner is ever renamed: `history`, `nowplaying`, `prefix`
  (`:211-215`).

`src/__tests__/commandRegistryInvariants.test.ts` is the gate for all of it. It reads names
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

- `MusicSlashCommands` — `slashCommands/music/__tests__/musicSlashCommands.test.ts:9-12` passes **2**
  args; production passes 4 (`startup.ts`, the `new MusicSlashCommands(...)` line). The
  trailing params are optional.
- `PlayCommands` — `textCommands/lastfm/playCommands.test.ts:221-225` passes **3**
  (`userService, lastfmRepository, updateService`), matching `startup.ts` (`new
  PlayCommands(...)`).
- `ChartCommands` — `chartCommands.test.ts:123-129` passes **5**; `:512-517` passes
  **4** and works, so the tail is optional.

Those three `startup.ts` sites are cited by expression rather than by line on purpose:
`startup.ts` is the file most often reshuffled, and a reference that is wrong the day it
is written is worse than one that names the expression. Every other reference in this
file is a `file:line`.

Two positional traps worth knowing:

- `prisma` is the **seventh** parameter of `TrackService`, not the first or the fifth.
  Passing it first compiles when the rest are `as never`, and then every query fails
  inside the service's own catch — indistinguishable from "this user has no plays"
  (`src/bot/services/trackService.db.test.ts:25-31`).
- Discriminating a command literal from an arbitrary object: a command has
  `executeAsync` or `execute` **and** no spread. `musicCommands` writes
  `{ ...def, executeAsync: ... }`, and counting a spread literal as a definition
  double-counts the name and manufactures a false clash
  (`commandRegistryInvariants.test.ts:78-89`).

## 6. Dead code in this subtree

- A builder assembled through a helper rather than
  `new SlashCommandBuilder().setName(...)` is not matched by the duplicate sweep
  (`commandRegistryInvariants.test.ts:285-290`). If you add a top-level command that
  way, it is invisible to the check.
- `getSlashCommandPayloads()` is the whole-registry read, for the same reason
  `getTextCommands()` exists: a single-name lookup cannot express "no two of these
  collide" (`textCommands/index.ts:125-136`).
- The dispatcher adds the prefix and splits on whitespace
  (`src/bot/handlers/commands/commandHandler.ts:197-203`), so a registered name or alias
  containing a dot or a space can never match anything.
