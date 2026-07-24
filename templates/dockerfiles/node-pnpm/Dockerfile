# node-pnpm — the proven shape (the relay-extracted pattern; see
# ARCHITECTURE.md §7). Stamps to `.sandcastle/Dockerfile` for any
# `factory.toml` `[environment] kind = "node-pnpm"`.

FROM node:22-bookworm

# System dependencies the agent needs inside the sandbox.
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (root, before the USER switch — corepack writes
# shims into a root-owned prefix). No version is pinned here: corepack reads
# the mounted repo's package.json "packageManager" field and fetches that
# exact version automatically, so this Dockerfile never drifts from the
# repo's own pin.
RUN corepack enable

# Build-args for UID/GID alignment: `sandcastle docker build-image` defaults
# these to the host user's UID/GID so image-built files and bind-mounted
# files share an owner without a runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at
# /home/agent/workspace and overrides the working directory to
# /home/agent/workspace at container start. Structure your Dockerfile so that
# /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
