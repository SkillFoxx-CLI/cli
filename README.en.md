# skillfoxx

Installs skills, MCP servers and CLI tools from the [SkillFoxx](https://skillfoxx.ru) catalog into your agents with one command.

```bash
npx skillfoxx add mcp/vv-mcp-server
```

Requires Node.js 18.18 or newer.

## Commands

| Command | What it does |
|---|---|
| `add <section>/<slug>` | installs a catalog entry into your agents |
| `remove <entry>` | removes what SkillFoxx installed |
| `update [entry]` | updates to the version SkillFoxx has rechecked |
| `list` | shows what is installed |
| `doctor` | checks installs: edited by hand, outdated, removed from the catalog, environment variables not set |
| `search <query>` | searches the catalog |
| `connect <agent>` | connects Claude Code, Codex, opencode or Cursor to SkillFoxx API: checks the key on the gateway and writes the address into the agent settings. The key comes from `SKILLFOXX_API_KEY` or a hidden prompt |

Options: `--agent claude-code,cursor` (or `all`), `--project`, `--global`, `-y`/`--yes`, `--force`, `--dry-run`, `--json`, `--allow-telemetry`, `--lang ru|en`.

## Agents

Claude Code, Cursor, VS Code, Codex, Gemini CLI, Devin, Cline, Zoo Code, OpenCode, Zed, Goose, Amp, Hermes Agent, SourceCraft, Coddy.

Hermes Agent: MCP servers go to `config.yaml` in the Hermes folder (`~/.hermes`, `%LOCALAPPDATA%\hermes` on Windows, or `HERMES_HOME`), so install them with `--global`. User skills land in `skills` in the same folder. Project skills live in `.agents/skills`, and Hermes loads them only after `hermes skills trust` in the project root.

Skills are installed as one copy in `.agents/skills` (project) or `~/.agents/skills` (user), with links in the agent folders. Codex and Zed read user skills straight from `~/.agents/skills`, Coddy reads `.coddy/skills` in a project, SourceCraft reads `.codeassistant/skills` and `~/.codeassistant/skills`. Links in `~/.codex/skills` left by versions before 0.4 are cleaned up by `remove` and `update`.

Without `--agent` the CLI picks the agent it runs inside, otherwise every agent found on the machine.

## What is checked before install

- The recipe is signed with the SkillFoxx key (Ed25519). Unsigned, forged or expired recipes are refused. Keys: https://skillfoxx.ru/.well-known/skillfoxx-recipe-keys.json
- Skill files come from GitHub at the pinned commit and are checked by the sha of every file and a combined digest.
- High risk entries install only after explicit consent. With `--yes` the reasons are printed to stderr.
- Entries with an open incident and entries removed from the catalog are refused.
- Recipes built automatically and not yet checked by hand come with a warning.
- When the author's README says the tool sends data back (telemetry), the plan shows what is sent. When the author names a variable that turns it off, the CLI offers to add it to the MCP server config before you confirm (yes by default, also with `--yes`). Keep sending on: `--allow-telemetry`. The choice is saved in the lock file and `update` repeats it.

## Configs and secrets

- The agent config is edited one key at a time: comments, indentation and other servers stay. A backup goes to `~/.skillfoxx/backups` before every edit.
- A key SkillFoxx did not install, or one edited by hand, is not replaced without `--force`.
- In a project a secret never goes into a file: the CLI writes an environment variable reference if the agent supports it, otherwise it prints instructions and suggests installing with `--global`.
- For the user scope the secret value goes into the agent config, the way the agents do it themselves. Lock files hold no values.
- `doctor` checks required variables against the current environment (names and status only, no values; secrets are listed first among problems). On macOS an app opened from the Dock or Launchpad does not see exports from `~/.zshrc`: after `add`, such variables get a hint about `launchctl setenv` or starting the agent from a terminal where the variable is already set.

## Lock files

`skillfoxx-lock.json` at the project root (worth committing) and `~/.skillfoxx/lock.json` for the user: entry, recipe hash, commit, agents, paths, dates. Override the user folder with `SKILLFOXX_HOME`.

## Telemetry

After `add`, `remove` and `update` the CLI sends an anonymous event: entry, agent, event, CLI version, a CI flag and a random install id from `~/.skillfoxx/config.json`. Paths, variables and user names are never sent. Disable it with `DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1` or `SKILLFOXX_TELEMETRY=0`.

## Exit codes

0 success, 1 failure, 2 `doctor` found problems, 3 the entry was removed or is blocked, 4 no automatic install, 5 a risk question needs an answer, 64 argument error.

## What the CLI does not do

It does not install arbitrary repositories outside the catalog, does not keep third party code at SkillFoxx and does not run commands from READMEs. Claude Code plugins are installed with the commands the CLI prints: it never runs them itself.

MIT license. Licenses of bundled packages: `dist/THIRD_PARTY_LICENSES.txt`.
