#!/bin/sh
# Builds the home-directory skeleton that is copied into every new user's encrypted home.
# Runs at image build time. Fails loudly if an upstream repo layout changes.
set -eu

SKEL=/usr/local/share/floq/skel
WORK=$(mktemp -d)
mkdir -p "$SKEL/.claude/skills" "$SKEL/.codex/skills"

# Claude loads this user-level memory file at startup in every Floq session.
# Keep the routing instruction outside the project so it does not edit user repos.
cat > "$SKEL/.claude/CLAUDE.md" <<'EOF'
# Floq session coordination

When the user asks you to recruit, delegate to, or coordinate another agent/session, use Floq's `floq-orchestrate` skill and Floq CLI by default. Floq sessions are the visible workers in the Floq workspace. Do not use Claude Code's built-in Agent tool or other hidden/local subagents for that request. Use native subagents only when the user explicitly asks for native/local subagents or explicitly names the Agent tool.

Before coordinating, read `~/.claude/skills/floq-orchestrate/SKILL.md` and check `floq --help`. Follow its authorization rules: the user's request must authorize recruitment, and only a lead session can recruit or dismiss. For ordinary single-agent work, stay in the current session.

Use the immutable Floq session UUID printed by `floq list` or `floq recruit` in later commands. Display titles can change, and provider conversation IDs are only for provider resume; do not confuse either with the Floq UUID. Agent names and roles do not select a model: check `floq models` and pass an exact ID with `floq recruit --model ID`. Recruitment supports `--cwd` and `--isolated` as documented in the skill.
EOF

# Codex reads ~/.codex/AGENTS.md as global startup instructions. This is the
# per-session CODEX_HOME, so this instruction is isolated from host preferences.
cat > "$SKEL/.codex/AGENTS.md" <<'EOF'
# Floq session coordination

When the user asks you to recruit, delegate to, or coordinate another agent/session, use Floq's `floq-orchestrate` skill and Floq CLI by default. Floq sessions are the visible workers in the Floq workspace. Do not use Codex's native subagents for that request unless the user explicitly asks for native/local subagents.

Before coordinating, read `~/.codex/skills/floq-orchestrate/SKILL.md` and check `floq --help`. Follow the skill's authorization rules: the user's request must authorize recruitment, and only a lead session can recruit or dismiss. For ordinary single-agent work, stay in the current session.

Use the immutable Floq session UUID printed by `floq list` or `floq recruit` in later commands. Display titles can change, and provider conversation IDs are only for provider resume; do not confuse either with the Floq UUID. Agent names and roles do not select a model: check `floq models` and pass an exact ID with `floq recruit --model ID`. Recruitment supports `--cwd` and `--isolated` as documented in the skill.
EOF

# --- Superpowers (obra/superpowers): skills for Claude Code and Codex ---
git clone --depth 1 --branch "${SUPERPOWERS_REF:-main}" https://github.com/obra/superpowers "$WORK/superpowers"
[ -d "$WORK/superpowers/skills" ] || { echo "superpowers: skills/ directory not found" >&2; exit 1; }
cp -r "$WORK/superpowers/skills/." "$SKEL/.claude/skills/"
cp -r "$WORK/superpowers/skills/." "$SKEL/.codex/skills/"

# --- Humanizer (blader/humanizer): a single SKILL.md ---
git clone --depth 1 --branch "${HUMANIZER_REF:-main}" https://github.com/blader/humanizer "$WORK/humanizer"
[ -f "$WORK/humanizer/SKILL.md" ] || { echo "humanizer: SKILL.md not found" >&2; exit 1; }
for target in .claude .codex; do
  mkdir -p "$SKEL/$target/skills/humanizer"
  cp "$WORK/humanizer/SKILL.md" "$SKEL/$target/skills/humanizer/SKILL.md"
done

# --- skill-creator (anthropics/skills, Apache-2.0), Claude Code only ---
# Pinned to a full commit hash; override with ANTHROPIC_SKILLS_REF (40 hex characters). Codex ships its own skill-creator, so this one is
# not copied for Codex. The skill's LICENSE.txt stays in its folder. Superpowers' writing-skills (above) already covers skill authoring
# for both providers.
ANTHROPIC_SKILLS_REF="${ANTHROPIC_SKILLS_REF:-ca45fc496a3436251f191354091d557da31c15b5}"
case "$ANTHROPIC_SKILLS_REF" in
  *[!0-9a-f]*|"") echo "anthropic skills: ANTHROPIC_SKILLS_REF must be a full 40-character commit hash" >&2; exit 1 ;;
esac
[ ${#ANTHROPIC_SKILLS_REF} -eq 40 ] || { echo "anthropic skills: ANTHROPIC_SKILLS_REF must be a full 40-character commit hash" >&2; exit 1; }
mkdir "$WORK/anthropic-skills"
git -C "$WORK/anthropic-skills" init -q
git -C "$WORK/anthropic-skills" remote add origin https://github.com/anthropics/skills
git -C "$WORK/anthropic-skills" fetch -q --depth 1 origin "$ANTHROPIC_SKILLS_REF" || { echo "anthropic skills: could not fetch commit $ANTHROPIC_SKILLS_REF" >&2; exit 1; }
git -C "$WORK/anthropic-skills" checkout -q FETCH_HEAD
[ "$(git -C "$WORK/anthropic-skills" rev-parse HEAD)" = "$ANTHROPIC_SKILLS_REF" ] || { echo "anthropic skills: fetched commit does not match $ANTHROPIC_SKILLS_REF" >&2; exit 1; }
[ -f "$WORK/anthropic-skills/skills/skill-creator/SKILL.md" ] && [ -f "$WORK/anthropic-skills/skills/skill-creator/LICENSE.txt" ] || { echo "anthropic skills: skills/skill-creator (SKILL.md and LICENSE.txt) not found" >&2; exit 1; }
mkdir -p "$SKEL/.claude/skills/skill-creator"
cp -r "$WORK/anthropic-skills/skills/skill-creator/." "$SKEL/.claude/skills/skill-creator/"

# --- Floq skills (vault + orchestration), shipped with the image ---
for target in .claude .codex; do
  cp -r /tmp/floq-skills/. "$SKEL/$target/skills/"
done

# --- Context7 MCP server for both agents ---
cat > "$SKEL/.claude.json" <<'JSON'
{
  "mcpServers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
JSON

cat > "$SKEL/.codex/config.toml" <<'TOML'
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
TOML

rm -rf "$WORK"
find "$SKEL" -type d -exec chmod 755 {} + && find "$SKEL" -type f -exec chmod 644 {} +
echo "skeleton built: $(find "$SKEL" -name SKILL.md | wc -l) skills"
