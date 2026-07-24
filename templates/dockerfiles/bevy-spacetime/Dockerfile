# bevy-spacetime — PREPARED for the game archetype pilot, not yet proven.
# ARCHITECTURE.md §8: an archetype exists only after its pilot (≥1 merged
# `agent:implement` PR); until the first game repo runs this shape end to
# end, treat the toolchain pins/install steps below as the org's current
# intent rather than a battle-tested recipe. Stamps to
# `.sandcastle/Dockerfile` for `factory.toml` `[environment]
# kind = "bevy-spacetime"`. Per FACTORY_SPEC.md §3, `node` MUST NOT be set
# for this (non-node) kind.

FROM rust:1-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  pkg-config \
  ca-certificates \
  # Bevy's Linux runtime deps (audio + input device access).
  libasound2-dev \
  libudev-dev \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# SpacetimeDB CLI — builds/publishes the Bevy client's server module.
# Unverified on CI (prepared shape, see header note).
RUN curl -fsSL https://install.spacetimedb.com | bash -s -- --yes

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupadd -o -g $AGENT_GID agent \
  && useradd -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -s /bin/bash agent
USER ${AGENT_UID}:${AGENT_GID}

RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/home/agent/.local/bin:/home/agent/.local/share/spacetime/bin:/home/agent/.cargo/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at
# /home/agent/workspace and overrides the working directory to
# /home/agent/workspace at container start. Structure your Dockerfile so that
# /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
