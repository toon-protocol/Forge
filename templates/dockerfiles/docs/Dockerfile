# docs — proven shape for prose/markdown factories whose oracle judges
# writing, not compiled code. Stamps to `.sandcastle/Dockerfile` for any
# `factory.toml` `[environment] kind = "docs"`. Per FACTORY_SPEC.md §3, non-
# node kinds MUST NOT set `[environment] node` — this shape carries no
# Node/pnpm toolchain, only what Sandcastle itself needs to run the agent.

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# If this factory's oracle needs a prose linter (Vale, markdownlint-cli2,
# etc.), install it explicitly here rather than dragging in a full node image
# just to run npx.

ARG AGENT_UID=1000
ARG AGENT_GID=1000

# debian:bookworm-slim has no pre-existing "node" user to rename (unlike the
# node-pnpm/npm-workspaces shapes), so the agent user is created directly.
RUN groupadd -o -g $AGENT_GID agent \
  && useradd -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -s /bin/bash agent
USER ${AGENT_UID}:${AGENT_GID}

RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at
# /home/agent/workspace and overrides the working directory to
# /home/agent/workspace at container start. Structure your Dockerfile so that
# /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
