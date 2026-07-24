# npm-workspaces — proven shape for repos whose toolchain lock is
# package-lock.json rather than pnpm's. Stamps to `.sandcastle/Dockerfile`
# for any `factory.toml` `[environment] kind = "npm-workspaces"`.
#
# Identical to the node-pnpm shape except there is no pnpm/corepack step: npm
# ships with the base node image, and npm workspaces need no extra activation.

FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at
# /home/agent/workspace and overrides the working directory to
# /home/agent/workspace at container start. Structure your Dockerfile so that
# /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
